---
title: Developing Backboard Studio
description: "Guide to building and developing Backboard Studio from source."
---

# Developing Backboard Studio

See the platform-specific instructions for building Backboard Studio from source:

- [macOS](./development/macos.md)
- [Linux](./development/linux.md)
- [Windows](./development/windows.md)

## Keychain access

Backboard Studio stores secrets in the system keychain.

However, when running a development build of Backboard Studio on macOS (and perhaps other
platforms) trying to access the keychain results in a lot of keychain prompts
that require entering your password over and over.

On macOS this is caused by the development build not having a stable identity.
Even if you choose the "Always Allow" option, the OS will still prompt you for
your password again the next time something changes in the binary.

This quickly becomes annoying and impedes development speed.

That is why, by default, when running a development build of Backboard Studio an alternative
credential provider is used to bypass the system keychain.

> **Note:** This is **only** the case for development builds. For all non-development
> release channels the system keychain is always used.

If you need to test something out using the real system keychain in a
development build, run Backboard Studio with the following environment variable set:

```
backboard_DEVELOPMENT_USE_KEYCHAIN=1
```

## Performance Measurements

Backboard Studio includes a frame time measurement system that can be used to profile how long it takes to render each frame. This is particularly useful when comparing rendering performance between different versions or when optimizing frame rendering code.

### Using backboard_MEASUREMENTS

To enable performance measurements, set the `backboard_MEASUREMENTS` environment variable:

```sh
export backboard_MEASUREMENTS=1
```

When enabled, Backboard Studio will print frame rendering timing information to stderr, showing how long each frame takes to render.

### Performance Comparison Workflow

Here's a typical workflow for comparing frame rendering performance between different versions:

1. **Enable measurements:**

   ```sh
   export backboard_MEASUREMENTS=1
   ```

2. **Test the first version:**

   - Checkout the commit you want to measure
   - Run Backboard Studio in release mode and use it for 5-10 seconds: `cargo run --release &> version-a`

3. **Test the second version:**

   - Checkout another commit you want to compare
   - Run Backboard Studio in release mode and use it for 5-10 seconds: `cargo run --release &> version-b`

4. **Generate comparison:**

   ```sh
   script/histogram version-a version-b
   ```

The `script/histogram` tool can accept as many measurement files as you like and will generate a histogram visualization comparing the frame rendering performance data between the provided versions.

### Using `util_macros::perf`

For benchmarking unit tests, annotate them with the `#[perf]` attribute from the `util_macros` crate. Then run `cargo
perf-test -p $CRATE` to benchmark them. See the rustdoc documentation on `crates/util_macros` and `tooling/perf` for
in-depth examples and explanations.

## ETW Profiling on Windows

Backboard Studio supports performance profiling with Event Tracing for Windows (ETW) to capture detailed performance data, including CPU, GPU, memory, disk, and file I/O activity. Data is saved to an `.etl` file, which can be opened in standard profiling tools for analysis.

ETW recordings may contain personally identifiable or security-sensitive information, such as paths to files and registry keys accessed, as well as process names. Please keep this in mind when sharing traces with others.

### Recording a trace

Open the command palette and run one of the following:

- `backboard: record etw trace`: records CPU, GPU, memory, and I/O activity
- `backboard: record etw trace with heap tracing`: includes heap allocation data for the Backboard Studio process

Backboard Studio will prompt you to choose a save location for the `.etl` file, then request administrator permission. Once granted, recording will begin.

### Saving or canceling

While a trace is recording, open the command palette and run one of the following:

- `backboard: save etw trace`: stops recording and saves the trace to disk
- `backboard: cancel etw trace`: stops recording without saving

Recordings automatically save after 60 seconds if not stopped manually.

## Contributor links

- [CONTRIBUTING.md](https://github.com/backboard/ide/blob/main/CONTRIBUTING.md)
- [Debugging Crashes](./development/debugging-crashes.md)
- [Code of Conduct](https://app.backboard.io/code-of-conduct)
- [Backboard Studio Contributor License](https://app.backboard.io/cla)
