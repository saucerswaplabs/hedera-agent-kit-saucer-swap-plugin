import {
    Context,
    HederaBuilder,
    HederaParameterNormaliser,
    IHederaMirrornodeService,
    handleTransaction,
} from "@hashgraph/hedera-agent-kit";
import { Client } from "@hiero-ledger/sdk";
import { fromBaseUnit } from "../utils";

export async function hasSufficientAllowance(
    ownerAccountId: string,
    spenderAccountId: string,
    tokenId: string,
    amount: bigint,
    mirrorNode: IHederaMirrornodeService,
): Promise<boolean> {
    try {
        const { allowances } = await mirrorNode.getTokenAllowances(ownerAccountId, spenderAccountId);
        const existing = allowances.find(a => a.token_id === tokenId);
        return !!existing && BigInt(existing.amount) >= amount;
    } catch {
        return false;
    }
}

/** @param amount - base units, as the mirror node reports allowances */
export async function ensureTokenAllowance(
    ownerAccountId: string,
    spenderAccountId: string,
    tokenId: string,
    amount: bigint,
    decimals: number,
    context: Context,
    client: Client,
    mirrorNode: IHederaMirrornodeService,
): Promise<void> {
    if (await hasSufficientAllowance(ownerAccountId, spenderAccountId, tokenId, amount, mirrorNode)) {
        return;
    }

    const approveParams = await HederaParameterNormaliser.normaliseApproveTokenAllowance(
        {
            ownerAccountId,
            spenderAccountId,
            tokenApprovals: [{ tokenId, amount: fromBaseUnit(amount, decimals).toNumber() }],
        },
        context,
        client,
        mirrorNode,
    );
    const approveTx = HederaBuilder.approveTokenAllowance(approveParams);
    await handleTransaction(approveTx, client, context, () =>
        `Approved ${amount.toString()} of token ${tokenId} for spender ${spenderAccountId}`
    );
}
