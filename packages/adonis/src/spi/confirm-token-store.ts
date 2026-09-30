/** One confirmation being spent — what {@link ConfirmTokenStore.claim} records. */
export interface ConfirmTokenClaim {
  /** SHA-256 (hex) of the token. The token itself is never stored. */
  hash: string;
  /** `ctx.actor.id` of the confirming actor. */
  actorRef: string;
  /** The tool the token was issued for. */
  tool: string;
  /** Epoch-ms the token stops being valid — after it the mark is dead weight and can be purged. */
  expiresAt: number;
}

/**
 * Makes a confirm token single use (see `defineConfirmedTool`). A signed token is stateless, so on
 * its own it stays valid until it expires: a double tap, a network retry or a model repeating the
 * call would commit twice inside that window. The store remembers which tokens were spent.
 *
 * Only the token's hash, the actor and the tool name are kept — never an argument or a value.
 */
export interface ConfirmTokenStore {
  /**
   * Spend the token. `true` = this caller holds it and may commit; `false` = it was already spent.
   * MUST be atomic: of two concurrent claims for one hash, exactly one gets `true`.
   */
  claim(input: ConfirmTokenClaim): Promise<boolean>;
  /** Give the token back — the commit failed after the claim, so the caller may try again. */
  release(hash: string): Promise<void>;
  /** Drop the marks of tokens that expired before `now` (epoch-ms, default the clock). Returns how many. */
  purgeExpired?(now?: number): Promise<number>;
}
