const app = window.deviceApp;
document.querySelector('#sign-in').onclick = () => app.signIn();
document.querySelector('#sign-out').onclick = () => app.signOut();
document.querySelector('#reconnect').onclick = () => app.reconnect();
document.querySelector('#stop').onclick = () => app.stop();
for (const input of document.querySelectorAll('[data-permission]')) input.onchange = () => app.permission(input.dataset.permission, input.checked);
app.onState(state => {
  document.querySelector('#account').textContent = state.username ? `${state.username}.imperfect.computer` : 'Your computer, here.';
  document.querySelector('#status').textContent = state.status;
  document.querySelector('#sign-in').hidden = !!state.username;
  document.querySelector('#sign-in').disabled = state.signingIn;
  document.querySelector('#sign-out').hidden = !state.username;
  document.querySelector('#reconnect').hidden = !state.username;
  document.querySelector('#reconnect').disabled = state.signingIn;
  for (const input of document.querySelectorAll('[data-permission]')) {
    input.checked = !!state.permissions[input.dataset.permission];
    input.disabled = !state.connected;
  }
  const items = state.events.slice().reverse().map(event => {
    const li = document.createElement('li');
    li.textContent = `${new Date(event.time).toLocaleTimeString()} · ${event.action} · ${event.detail || ''} · ${event.status}`;
    return li;
  });
  document.querySelector('#activity').replaceChildren(...items);
});
app.ready();
