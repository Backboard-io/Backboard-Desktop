const copyButton = document.querySelector("#copy-command");
copyButton.addEventListener("click", async () => {
  const status = document.querySelector("#copy-status");
  try {
    await navigator.clipboard.writeText(
      "git clone https://github.com/Backboard-io/Backboard-Desktop.git",
    );
    status.textContent =
      "Copied. Follow the setup guide for your platform after cloning.";
    copyButton.textContent = "✓";
  } catch {
    status.textContent =
      "Select and copy the command above to clone the project.";
  }
});
