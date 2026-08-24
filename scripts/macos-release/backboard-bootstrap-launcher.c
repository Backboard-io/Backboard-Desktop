#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef BACKBOARD_REAL_EXECUTABLE_NAME
#error "BACKBOARD_REAL_EXECUTABLE_NAME must be defined"
#endif

#ifndef BACKBOARD_SUPPORT_DIRECTORY_NAME
#error "BACKBOARD_SUPPORT_DIRECTORY_NAME must be defined"
#endif

#ifndef BACKBOARD_BOOTSTRAP_SENTINEL_NAME
#error "BACKBOARD_BOOTSTRAP_SENTINEL_NAME must be defined"
#endif

#ifndef BACKBOARD_BOOTSTRAP_DELAY_SECONDS
#define BACKBOARD_BOOTSTRAP_DELAY_SECONDS 25
#endif

extern char **environ;

static int sentinel_matches_installation(const char *sentinel_path, const char *installation_identity) {
	char stored_identity[128];
	const int sentinel = open(sentinel_path, O_RDONLY);
	if (sentinel < 0) {
		return 0;
	}

	const ssize_t bytes_read = read(sentinel, stored_identity, sizeof(stored_identity) - 1);
	(void)close(sentinel);
	if (bytes_read < 0) {
		return 0;
	}
	stored_identity[bytes_read] = '\0';
	return strcmp(stored_identity, installation_identity) == 0;
}

static int create_bootstrap_sentinel_after_delay(const char *real_executable_path) {
	const char *home = getenv("HOME");
	if (home == NULL || home[0] == '\0') {
		sleep(BACKBOARD_BOOTSTRAP_DELAY_SECONDS);
		return 1;
	}

	struct stat executable_stat;
	if (stat(real_executable_path, &executable_stat) != 0) {
		sleep(BACKBOARD_BOOTSTRAP_DELAY_SECONDS);
		return 1;
	}

	char installation_identity[128];
	const int identity_length = snprintf(
		installation_identity,
		sizeof(installation_identity),
		"%llu:%llu\n",
		(unsigned long long)executable_stat.st_dev,
		(unsigned long long)executable_stat.st_ino
	);
	if (identity_length < 0 || (size_t)identity_length >= sizeof(installation_identity)) {
		sleep(BACKBOARD_BOOTSTRAP_DELAY_SECONDS);
		return 1;
	}

	char support_directory[PATH_MAX];
	char library_directory[PATH_MAX];
	char application_support_directory[PATH_MAX];
	char sentinel_path[PATH_MAX];
	const int library_length = snprintf(library_directory, sizeof(library_directory), "%s/Library", home);
	const int application_support_length = snprintf(
		application_support_directory,
		sizeof(application_support_directory),
		"%s/Library/Application Support",
		home
	);
	const int support_length = snprintf(
		support_directory,
		sizeof(support_directory),
		"%s/Library/Application Support/%s",
		home,
		BACKBOARD_SUPPORT_DIRECTORY_NAME
	);
	if (
		library_length < 0 || (size_t)library_length >= sizeof(library_directory) ||
		application_support_length < 0 || (size_t)application_support_length >= sizeof(application_support_directory) ||
		support_length < 0 || (size_t)support_length >= sizeof(support_directory)
	) {
		sleep(BACKBOARD_BOOTSTRAP_DELAY_SECONDS);
		return 1;
	}

	const int sentinel_length = snprintf(
		sentinel_path,
		sizeof(sentinel_path),
		"%s/%s",
		support_directory,
		BACKBOARD_BOOTSTRAP_SENTINEL_NAME
	);
	if (sentinel_length < 0 || (size_t)sentinel_length >= sizeof(sentinel_path)) {
		sleep(BACKBOARD_BOOTSTRAP_DELAY_SECONDS);
		return 1;
	}

	if (sentinel_matches_installation(sentinel_path, installation_identity)) {
		return 0;
	}

	// The 3.0.0 updater launches a newly moved and re-registered bundle
	// immediately. Giving each newly installed copy a short settling window
	// avoids the LaunchServices/code-signing race while keeping the same launch
	// PID alive for the old updater's health check. The executable inode makes
	// reinstalls of the same release distinct without slowing later launches of
	// the same installed copy.
	sleep(BACKBOARD_BOOTSTRAP_DELAY_SECONDS);
	if (
		(mkdir(library_directory, 0700) != 0 && errno != EEXIST) ||
		(mkdir(application_support_directory, 0700) != 0 && errno != EEXIST) ||
		(mkdir(support_directory, 0700) != 0 && errno != EEXIST)
	) {
		return 1;
	}
	const int sentinel = open(sentinel_path, O_CREAT | O_WRONLY | O_TRUNC, 0600);
	if (sentinel >= 0) {
		(void)write(sentinel, installation_identity, (size_t)identity_length);
		(void)close(sentinel);
	}
	return 1;
}

static void schedule_post_handoff_activation(const char *launcher_path) {
	char bundle_path[PATH_MAX];
	const char *contents_suffix = strstr(launcher_path, "/Contents/MacOS/");
	if (contents_suffix == NULL) {
		return;
	}
	const size_t bundle_length = (size_t)(contents_suffix - launcher_path);
	if (bundle_length == 0 || bundle_length >= sizeof(bundle_path)) {
		return;
	}
	(void)memcpy(bundle_path, launcher_path, bundle_length);
	bundle_path[bundle_length] = '\0';

	const pid_t app_pid = getpid();
	const pid_t watcher_pid = fork();
	if (watcher_pid < 0) {
		return;
	}
	if (watcher_pid > 0) {
		(void)waitpid(watcher_pid, NULL, 0);
		return;
	}
	const pid_t activation_pid = fork();
	if (activation_pid != 0) {
		_exit(0);
	}

	// The updater embedded in 3.0.5 can finish its health check while this
	// compatibility launcher is still sleeping, then lose foreground state when
	// execve hands the same PID to Electron. Re-open the exact bundle briefly
	// after that handoff so current installations receive a visible next-version
	// window. The watcher exits if the app itself has already quit.
	for (int attempt = 0; attempt < 6; attempt++) {
		sleep(2);
		if (kill(app_pid, 0) != 0) {
			_exit(0);
		}
		pid_t open_pid;
		char *const open_argv[] = { "open", bundle_path, NULL };
		if (posix_spawn(&open_pid, "/usr/bin/open", NULL, NULL, open_argv, environ) == 0) {
			(void)waitpid(open_pid, NULL, 0);
		}
	}
	_exit(0);
}

int main(int argc, char **argv) {
	(void)argc;
	char launcher_path[PATH_MAX];
	uint32_t launcher_path_size = (uint32_t)sizeof(launcher_path);
	if (_NSGetExecutablePath(launcher_path, &launcher_path_size) != 0) {
		fprintf(stderr, "Backboard bootstrap launcher path is too long.\n");
		return 126;
	}

	char *last_separator = strrchr(launcher_path, '/');
	if (last_separator == NULL) {
		fprintf(stderr, "Backboard bootstrap launcher has no executable directory.\n");
		return 126;
	}
	*last_separator = '\0';

	char real_executable_path[PATH_MAX];
	const int real_path_length = snprintf(
		real_executable_path,
		sizeof(real_executable_path),
		"%s/%s",
		launcher_path,
		BACKBOARD_REAL_EXECUTABLE_NAME
	);
	if (real_path_length < 0 || (size_t)real_path_length >= sizeof(real_executable_path)) {
		fprintf(stderr, "Backboard real executable path is too long.\n");
		return 126;
	}

	*last_separator = '/';
	const int delayed_first_launch = create_bootstrap_sentinel_after_delay(real_executable_path);
	if (delayed_first_launch) {
		schedule_post_handoff_activation(launcher_path);
	}

	// Preserve the public CFBundleExecutable path in argv[0]. The legacy updater
	// identifies the exact launched process from this command line while execve
	// keeps the LaunchServices PID and application identity unchanged.
	argv[0] = launcher_path;
	execve(real_executable_path, argv, environ);
	fprintf(stderr, "Could not launch Backboard Studio: %s\n", strerror(errno));
	return 126;
}
