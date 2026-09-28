const form = document.querySelector("#host-form");
const result = document.querySelector("#connection-result");
const status = document.querySelector("#cloud-status");
function updateConnectionFields() {
  const direct = form.elements.connection.value === "direct";
  document.querySelector("#alias-field").hidden = direct;
  document.querySelector("#endpoint-field").hidden = !direct;
  form.elements.alias.required = !direct;
  form.elements.alias.disabled = direct;
  form.elements.endpoint.required = direct;
  form.elements.endpoint.disabled = !direct;
  form.elements.endpoint.setCustomValidity("");
}
form.addEventListener("change", updateConnectionFields);
form.elements.endpoint.addEventListener("input", () =>
  form.elements.endpoint.setCustomValidity(""),
);
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const direct = form.elements.connection.value === "direct";
  let endpoint = "ws://127.0.0.1:8081";
  if (direct) {
    try {
      const url = new URL(form.elements.endpoint.value);
      if (
        url.protocol !== "wss:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw Error();
      endpoint = url.href;
    } catch {
      form.elements.endpoint.setCustomValidity(
        "Use a wss:// endpoint without embedded credentials, query parameters, or fragments.",
      );
      form.elements.endpoint.reportValidity();
      return;
    }
  }
  const name = form.elements.name.value.trim();
  if (!name) {
    form.elements.name.setCustomValidity("Enter a workspace name.");
    form.elements.name.reportValidity();
    return;
  }
  document.querySelector("#result-name").textContent = name;
  document.querySelector("#result-display-name").textContent = name;
  document.querySelector("#result-endpoint").textContent = endpoint;
  document.querySelector("#result-folder").textContent =
    form.elements.folder.value;
  document.querySelector("#tunnel-step").hidden = direct;
  document.querySelector("#ssh-command").textContent =
    `ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8081:127.0.0.1:8081 ${form.elements.alias.value}`;
  form.hidden = true;
  result.hidden = false;
  result.focus();
  status.textContent =
    "Connection guide prepared. No server has been contacted.";
});
form.elements.name.addEventListener("input", () =>
  form.elements.name.setCustomValidity(""),
);
document.querySelector("#edit-connection").addEventListener("click", () => {
  result.hidden = true;
  form.hidden = false;
  form.elements.name.focus();
});
document.querySelector("#copy-tunnel").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(
      document.querySelector("#ssh-command").textContent,
    );
    status.textContent = "SSH tunnel command copied.";
  } catch {
    status.textContent = "Select and copy the command above.";
  }
});
updateConnectionFields();
