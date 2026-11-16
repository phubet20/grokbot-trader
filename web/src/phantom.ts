declare global { interface Window { phantom?: any; solana?: any } }
export const getPhantom = () => (typeof window !== 'undefined' ? window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null) : null);
export function phantomBrowseUrl(href = typeof window !== 'undefined' ? window.location.href : '', origin = typeof window !== 'undefined' ? window.location.origin : '') {
  return `https://phantom.app/ul/browse/${encodeURIComponent(href)}?ref=${encodeURIComponent(origin)}`;
}
