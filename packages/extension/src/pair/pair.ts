import { sendUntilReceived } from '../background/pairing';

const status = document.getElementById('status')!;
const nonce = location.hash.slice(1);
if (!/^[A-Za-z0-9_-]{32}$/.test(nonce)) {
  status.textContent = 'Open this profile using browser_open_instance in your AI client.';
} else {
  const timer = setTimeout(() => { status.textContent = 'Connection timed out. Retry browser_open_instance in your AI client.'; }, 15000);
  void sendUntilReceived(() => chrome.runtime.sendMessage({ type: 'browpilot-pair', nonce })).then(result => {
    clearTimeout(timer);
    status.textContent = result?.paired ? 'Profile connected. Your AI client can now use this browser. You can close this tab.' : (result?.error ?? 'Pairing expired. Retry browser_open_instance.');
    if (result?.paired) history.replaceState(null, '', 'pair.html');
  }).catch(error => { clearTimeout(timer); status.textContent = `Connection failed: ${error.message}`; });
}
