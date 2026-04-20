// Wallet integration for Meebits NFT ownership.
// Reads ERC-721 balance and tokens owned on the Meebits contract (0x7Bd29408f11D2bFC23c34f18275bBf23bB716Bc7).
// Uses ethers.js v6 loaded dynamically from CDN to keep main bundle light.

const MEEBITS_CONTRACT = '0x7Bd29408f11D2bFC23c34f18275bBf23bB716Bc7';

// Minimal ERC-721 Enumerable ABI for what we need.
const MEEBITS_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
];

let _ethers = null;
let _provider = null;

async function loadEthers() {
  if (_ethers) return _ethers;
  // Dynamic ESM import from CDN
  const mod = await import('https://cdn.jsdelivr.net/npm/ethers@6.13.2/dist/ethers.min.js');
  _ethers = mod;
  return _ethers;
}

export const Wallet = {
  isAvailable() {
    return typeof window !== 'undefined' && !!window.ethereum;
  },

  /**
   * Requests account access and returns connected address.
   * Throws on user rejection or missing wallet.
   */
  async connect() {
    if (!this.isAvailable()) {
      throw new Error('No Ethereum wallet detected. Install MetaMask or a compatible wallet.');
    }
    const ethers = await loadEthers();
    _provider = new ethers.BrowserProvider(window.ethereum);
    const accounts = await _provider.send('eth_requestAccounts', []);
    if (!accounts || !accounts[0]) throw new Error('No account returned.');
    return accounts[0];
  },

  /**
   * Returns array of Meebit token IDs owned by the given address.
   * Relies on ERC-721 Enumerable (Meebits supports it).
   */
  async getOwnedMeebits(address) {
    if (!_provider) {
      const ethers = await loadEthers();
      _provider = new ethers.BrowserProvider(window.ethereum);
    }
    const ethers = await loadEthers();
    const contract = new ethers.Contract(MEEBITS_CONTRACT, MEEBITS_ABI, _provider);
    const balRaw = await contract.balanceOf(address);
    const bal = Number(balRaw);
    if (bal === 0) return [];
    const ids = [];
    // Limit to 50 to avoid hammering RPC if the address holds hundreds.
    const limit = Math.min(bal, 50);
    for (let i = 0; i < limit; i++) {
      try {
        const id = await contract.tokenOfOwnerByIndex(address, i);
        ids.push(Number(id));
      } catch (e) {
        console.warn('[wallet] token read failed at index', i, e?.message);
        break;
      }
    }
    return ids;
  },

  /**
   * Disconnect (clears local provider ref; actual wallet permission persists).
   */
  disconnect() {
    _provider = null;
  },
};
