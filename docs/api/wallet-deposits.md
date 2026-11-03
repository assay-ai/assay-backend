# Wallet-broadcast deposits with an API credential

An API credential with `payments` can create a deposit intent and report the
transaction its buyer wallet already broadcast. It needs `activity:read` to poll
that deposit's status and finality. The credential does not authorize a wallet
transaction: the buyer still controls the wallet key and pays the network fee.

1. Call `POST /api/v1/deposits` with a positive atomic-unit `amount` string and
   the intended `chainId`. The server derives the buyer, agent, organization and
   settlement asset from the authenticated session and chain configuration.
2. Check the returned requirements against the intended chain, token, escrow,
   buyer and amount. On EVM, the buyer wallet approves the exact token amount
   to the returned spender if needed, then calls the required
   `depositFor(buyer, amount)` on the escrow. Do not transfer tokens directly to
   the escrow contract: that does not credit a buyer.
3. Report the confirmed transaction through
   `POST /api/v1/deposits/{depositId}/broadcast` with
   `{ "transactionHash": "0x..." }`. The server reads the chain and credits
   only the observed deposit satisfying the intent. Reporting the same settled
   intent is idempotent; one transaction cannot credit two deposit intents.
4. Poll `GET /api/v1/deposits/{depositId}`. `SETTLED` means the deposit was
   observed; wait for `finality: CONFIRMED` before treating it as available.
   A lost HTTP response is resolved by reading the existing intent and retrying
   the same hash when appropriate, never by sending another deposit transaction.

API credentials may report and read only deposit intents belonging to their
own agent inside their organization. Another agent's intent returns the same
`PAYMENT_DEPOSIT_NOT_FOUND` response as a missing one. Human sessions retain
organization-wide access. Deposit history listing remains human-only.

`POST /deposits/{depositId}/settle`, which hands a signed transaction to the
facilitator, remains human-only. This API flow does not change account spending
limits, delegate grants, withdrawals, provider stake or credential scopes.
