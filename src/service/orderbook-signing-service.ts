import { AgentMode, Context } from "@hashgraph/hedera-agent-kit";
import type { Client, PublicKey } from "@hiero-ledger/sdk";
import { ethers } from "ethers";
import { OperatorSigningUnavailableError } from "../errors";
import { EIP712Domain, SerializedOrder } from "./orderbook-api-service.interface";

/**
 * Off-chain signing for the SaucerSwap V3 Orderbook API, driven entirely by
 * the agent-kit Client's operator signing capability
 * (client.getOperator().transactionSigner) — the same signing source the
 * existing swap_v2_tool relies on to execute transactions. The raw private
 * key is never read, held, or logged by this module.
 *
 * Semantics mirror the authoritative reference client
 * (saucerswap-server/src/scripts/orderbook/api/client.ts):
 *  - Auth challenge: HIP-820 prefixed raw sign
 *    ('\x19Hedera Signed Message:\n' + <len> + <msg>), hex signature.
 *  - Orders: EIP-712 typed data. ED25519 signs the typed-data hash bytes;
 *    ECDSA produces a standard 65-byte (r,s,v) EVM signature. Both are
 *    prefixed with the 0x00 EIP-712 mode byte on the wire.
 */

const HEDERA_MSG_PREFIX = "\x19Hedera Signed Message:\n";

/** EIP-712 mode byte for the order signature wire format. */
export const SIG_MODE_EIP712 = 0x00;

/** EIP-712 type definitions for PartialFillLimitOrder (mirrors the reference client). */
export const EIP712_ORDER_TYPES: Record<string, ethers.TypedDataField[]> = {
  PartialFillLimitOrder: [
    { name: "info", type: "OrderInfo" },
    { name: "input", type: "PartialFillInputToken" },
    { name: "output", type: "OutputToken" },
    { name: "makerOnly", type: "bool" },
    { name: "takerOnce", type: "bool" },
    { name: "maxTakerFeePips", type: "uint32" },
    { name: "maxMakerFeePips", type: "uint32" },
  ],
  OrderInfo: [
    { name: "reactor", type: "address" },
    { name: "swapper", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "additionalValidationContract", type: "address" },
    { name: "additionalValidationData", type: "bytes" },
  ],
  PartialFillInputToken: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  OutputToken: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "recipient", type: "address" },
  ],
};

export type OperatorKeyType = "ED25519" | "ECDSA_SECP256K1";

export interface OperatorSigner {
  accountId: string;
  publicKey: PublicKey;
  keyType: OperatorKeyType;
  sign: (message: Uint8Array) => Promise<Uint8Array>;
}

/** Discriminate the operator key type from its raw public key length (32 = ED25519, 33 = compressed secp256k1). */
export const keyTypeFromPublicKey = (publicKey: PublicKey): OperatorKeyType =>
  publicKey.toBytesRaw().length === 32 ? "ED25519" : "ECDSA_SECP256K1";

/**
 * Resolve the operator signing capability from the client, or throw a clear
 * error. RETURN_BYTES mode has no operator key, so orderbook trading tools
 * cannot run in it — the orderbook flow needs off-chain message signatures,
 * not transaction bytes.
 */
export const getOperatorSigner = (client: Client, context: Context): OperatorSigner => {
  if (context.mode === AgentMode.RETURN_BYTES) {
    throw new OperatorSigningUnavailableError("context mode is RETURN_BYTES");
  }
  const operator = client.getOperator();
  if (!operator) {
    throw new OperatorSigningUnavailableError("no operator configured on the client");
  }
  return {
    accountId: operator.accountId.toString(),
    publicKey: operator.publicKey,
    keyType: keyTypeFromPublicKey(operator.publicKey),
    sign: operator.transactionSigner,
  };
};

/**
 * Sign an auth challenge message (HIP-820 prefixed raw sign) and return the
 * signature as a plain hex string (no 0x prefix), as expected by
 * POST /auth/verify.
 *
 * The SDK operator signer applies the correct per-key-type primitive:
 * ED25519 signs the message bytes directly; ECDSA signs keccak256(message) —
 * both matching the reference client's PrivateKey.sign behaviour.
 */
export const signAuthChallenge = async (
  signer: OperatorSigner,
  message: string,
): Promise<string> => {
  const prefixedMsg = HEDERA_MSG_PREFIX + message.length + message;
  const sigBytes = await signer.sign(Buffer.from(prefixedMsg));
  return Buffer.from(sigBytes).toString("hex");
};

const prefixedHex = (mode: number, inner: Uint8Array): string =>
  "0x" + Buffer.concat([Buffer.from([mode]), Buffer.from(inner)]).toString("hex");

/** Strip meta — only the EIP-712 struct fields are part of the signed digest. */
const orderForSigning = (order: SerializedOrder) => ({
  info: order.info,
  input: order.input,
  output: order.output,
  makerOnly: order.makerOnly,
  takerOnce: order.takerOnce,
  maxTakerFeePips: order.maxTakerFeePips,
  maxMakerFeePips: order.maxMakerFeePips,
});

/**
 * Sign a built order (EIP-712) with the operator key and return the
 * mode-byte-prefixed hex signature expected by POST /orders/save.
 *
 * ED25519: sign the 32-byte typed-data hash directly (64-byte signature).
 * ECDSA:   the SDK signer computes keccak256(message) internally, so we feed
 *          it the EIP-712 preimage (0x1901 || domainSeparator || structHash);
 *          the resulting compact (r,s) is completed with the recovery byte v
 *          resolved against the operator public key — yielding the standard
 *          65-byte EVM signature the server verifies.
 */
export const signOrder = async (
  signer: OperatorSigner,
  order: SerializedOrder,
  domain: EIP712Domain,
): Promise<string> => {
  const value = orderForSigning(order);

  if (signer.keyType === "ED25519") {
    const hash = ethers.TypedDataEncoder.hash(domain, EIP712_ORDER_TYPES, value);
    const sigBytes = await signer.sign(ethers.getBytes(hash));
    return prefixedHex(SIG_MODE_EIP712, sigBytes);
  }

  // ECDSA_SECP256K1
  const preimage = ethers.TypedDataEncoder.encode(domain, EIP712_ORDER_TYPES, value);
  const digest = ethers.keccak256(preimage);
  const compact = await signer.sign(ethers.getBytes(preimage));
  if (compact.length !== 64) {
    throw new OperatorSigningUnavailableError(
      `unexpected ECDSA signature length ${compact.length} (expected 64-byte compact r||s)`,
    );
  }
  const r = ethers.hexlify(compact.slice(0, 32));
  const s = ethers.hexlify(compact.slice(32, 64));
  const expectedPubKey = ethers.SigningKey.computePublicKey(
    "0x" + Buffer.from(signer.publicKey.toBytesRaw()).toString("hex"),
    true,
  );
  for (const v of [27, 28]) {
    const candidate = ethers.Signature.from({ r, s, v });
    const recovered = ethers.SigningKey.recoverPublicKey(digest, candidate);
    if (ethers.SigningKey.computePublicKey(recovered, true) === expectedPubKey) {
      return prefixedHex(SIG_MODE_EIP712, ethers.getBytes(candidate.serialized));
    }
  }
  throw new OperatorSigningUnavailableError(
    "could not resolve ECDSA recovery byte against the operator public key",
  );
};
