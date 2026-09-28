export function connectionHealth(state, now = Date.now()) {
  const registrationReady = state.published === true && Date.parse(state.expiresAt) > now;
  return { ok: state.connected === true && registrationReady,
    tunnelConnected: state.connected === true, registrationReady };
}
