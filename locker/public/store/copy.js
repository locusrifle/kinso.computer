// thanks.html: a copy button next to the sentence and the command. Buttons
// stay hidden without JavaScript; the blocks select whole on a click anyway.

function select(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

for (const button of document.querySelectorAll('button[data-copy]')) {
  const target = document.getElementById(button.dataset.copy);
  if (target == null) continue;
  button.hidden = false;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(target.textContent.trim());
      button.textContent = 'copied';
    } catch {
      select(target);
      button.textContent = 'selected; ctrl+c';
    }
    setTimeout(() => { button.textContent = 'copy'; }, 2000);
  });
}
