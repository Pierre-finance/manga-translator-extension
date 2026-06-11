const captureBtn = document.getElementById("captureBtn");
const btnLabel = captureBtn.querySelector(".btn-label");
const btnIcon = captureBtn.querySelector(".btn-icon");

const stateEmpty = document.getElementById("stateEmpty");
const stateSuccess = document.getElementById("stateSuccess");
const stateError = document.getElementById("stateError");
const capturePreview = document.getElementById("capturePreview");
const errorMessage = document.getElementById("errorMessage");

function showState(state) {
  stateEmpty.classList.add("hidden");
  stateSuccess.classList.add("hidden");
  stateError.classList.add("hidden");
  state.classList.remove("hidden");
}

function setLoading(loading) {
  captureBtn.disabled = loading;
  if (loading) {
    captureBtn.classList.add("loading");
    btnIcon.textContent = "⏳";
    btnLabel.textContent = "Capture en cours…";
  } else {
    captureBtn.classList.remove("loading");
    btnIcon.textContent = "📸";
    btnLabel.textContent = "Capturer et traduire";
  }
}

captureBtn.addEventListener("click", () => {
  setLoading(true);

  chrome.runtime.sendMessage({ type: "CAPTURE_TAB" }, (response) => {
    setLoading(false);

    if (chrome.runtime.lastError) {
      errorMessage.textContent =
        "Impossible de contacter l'extension. Recharge la page et réessaie.";
      showState(stateError);
      return;
    }

    if (response.success) {
      capturePreview.src = response.dataURL;
      showState(stateSuccess);
    } else {
      errorMessage.textContent = response.error;
      showState(stateError);
    }
  });
});
