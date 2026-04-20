// Delegate.xyz v2 integration.
//
// Lets a wallet holder (hot wallet) represent delegated Meebits that are
// actually held by their cold wallet. Standard use case: cold wallet holds
// valuable Meebits and delegates to a hot wallet for gaming/authentication.
//
// Registry contract: 0x00000000000000447e69651d841bD8D104Bed493
// Network: Ethereum mainnet
//
// Reference: https://docs.delegate.xyz/technical-documentation/delegate-registry

const DELEGATE_REGISTRY_V2 = '0x00000000000000447e69651d841bD8D104Bed493';

// Minimal ABI — we only need one read function.
// `getIncomingDelegations(address to)` returns all delegations TO a wallet,
// which tells us which cold wallets have delegated to this hot wallet.
const DELEGATE_ABI = [
  {
    "inputs": [{ "name": "to", "type": "address" }],
    "name": "getIncomingDelegations",
    "outputs": [{
      "components": [
        { "name": "type_", "type": "uint8" },
        { "name": "to", "type": "address" },
        { "name": "from", "type": "address" },
        { "name": "rights", "type": "bytes32" },
        { "name": "contract_", "type": "address" },
        { "name": "tokenId", "type": "uint256" },
        { "name": "amount", "type": "uint256" }
      ],
      "name": "",
      "type": "tuple[]"
    }],
    "stateMutability": "view",
    "type": "function"
  }
];

const MEEBITS_CONTRACT = '0x7Bd29408f11D2bFC23c34f18275bBf23bB716Bc7';

/**
 * Finds all cold wallets that have delegated Meebit-access to the given hot wallet.
 * Returns deduplicated array of checksummed addresses.
 *
 * Delegation types in v2:
 *   0 = NONE
 *   1 = ALL          (delegated everything)
 *   2 = CONTRACT     (delegated a whole contract, e.g. all Meebits)
 *   3 = ERC721       (delegated a specific token)
 *   4 = ERC20
 *   5 = ERC1155
 *
 * We want types 1, 2 (all or contract matching Meebits), and 3 (specific Meebit token).
 */
export async function findDelegatingWallets(ethers, provider, hotWalletAddress) {
  try {
    const contract = new ethers.Contract(DELEGATE_REGISTRY_V2, DELEGATE_ABI, provider);
    const delegations = await contract.getIncomingDelegations(hotWalletAddress);
    const cold = new Set();

    for (const d of delegations) {
      const type = Number(d.type_);
      const contractAddr = (d.contract_ || '').toLowerCase();
      const meebitsAddr = MEEBITS_CONTRACT.toLowerCase();

      // Accept: ALL delegation, CONTRACT-level for Meebits, or ERC721 for a Meebit token
      if (type === 1) {
        cold.add(d.from);
      } else if (type === 2 && contractAddr === meebitsAddr) {
        cold.add(d.from);
      } else if (type === 3 && contractAddr === meebitsAddr) {
        cold.add(d.from);
      }
    }

    return Array.from(cold);
  } catch (err) {
    console.warn('[delegate] lookup failed (contract may not be deployed on this network, or RPC is slow)', err);
    return [];
  }
}
