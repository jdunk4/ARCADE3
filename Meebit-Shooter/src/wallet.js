// Wallet + delegation integration for Meebits.
// Uses ethers.js v6 loaded dynamically from CDN.
//
// On connect():
//   1. Request wallet address
//   2. Read Meebit balance of hot wallet
//   3. Query delegate.xyz v2 for cold wallets that have delegated to hot
//   4. Read Meebit balances of those cold wallets
//   5. Return combined list tagged with source (owned vs delegated)

import { findDelegatingWallets } from './delegation.js';

const MEEBITS_CONTRACT = '0x7Bd29408f11D2bFC23c34f18275bBf23bB716Bc7';

const MEEBITS_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
];

let _ethers = null;
let _provider = null;

async function loadEthers() {
  if (_ethers) return _ethers;
  const mod = await import('https://esm.sh/ethers@6.13.2');
  _ethers = mod;
  return _ethers;
}

export const Wallet = {
  isAvailable() {
    return typeof window !== 'undefined' && !!window.ethereum;
  },

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
   * Returns all Meebit IDs accessible to the hot wallet: directly owned +
   * delegated via delegate.xyz v2.
   *
   * Result: Array<{ id: number, source: 'owned'|'delegated', owner: string }>
   */
  async getAccessibleMeebits(hotWallet) {
    const ethers = await loadEthers();
    if (!_provider) _provider = new ethers.BrowserProvider(window.ethereum);

    const contract = new ethers.Contract(MEEBITS_CONTRACT, MEEBITS_ABI, _provider);

    // Own Meebits
    const owned = await this._readMeebitsFor(contract, hotWallet, 'owned');

    // Delegated — find cold wallets that authorized this hot wallet
    let cold = [];
    try {
      cold = await findDelegatingWallets(ethers, _provider, hotWallet);
    } catch (e) {
      console.warn('[wallet] delegate lookup skipped', e);
    }

    const delegatedLists = await Promise.all(
      cold.map((addr) => this._readMeebitsFor(contract, addr, 'delegated'))
    );
    const delegated = delegatedLists.flat();

    // Dedupe by id, preferring owned
    const seen = new Set();
    const out = [];
    for (const m of owned) if (!seen.has(m.id)) { seen.add(m.id); out.push(m); }
    for (const m of delegated) if (!seen.has(m.id)) { seen.add(m.id); out.push(m); }
    return out;
  },

  async _readMeebitsFor(contract, address, source) {
    try {
      const balRaw = await contract.balanceOf(address);
      const bal = Number(balRaw);
      if (bal === 0) return [];
      const limit = Math.min(bal, 50);
      const out = [];
      for (let i = 0; i < limit; i++) {
        try {
          const id = await contract.tokenOfOwnerByIndex(address, i);
          out.push({ id: Number(id), source, owner: address });
        } catch (e) { break; }
      }
      return out;
    } catch (e) {
      console.warn('[wallet] read failed for', address, e?.message);
      return [];
    }
  },

  // Back-compat
  async getOwnedMeebits(address) {
    const all = await this.getAccessibleMeebits(address);
    return all.map((m) => m.id);
  },

  disconnect() { _provider = null; },
};
