// Inventory carries the configured authority even while its PC is offline.
// Never choose a different computer merely because it is reachable.
export function usageOwner(machines, authority, localOnly = false) {
  const self = machines.find(m => m.self);
  return localOnly ? self?.id : authority || machines.find(m => m.home)?.id || self?.id;
}
