/* ------------------------------------------------------------------ *
 * Verification policy — how a committed save is judged on a platform.
 *
 * Exists because a live run that ground-truth succeeded was reported as
 * `failed`: a document-wide `[role="alert"]` sweep matched the platform's
 * own post-save success notification. What distinguishes a blocking
 * validation error from a notification is platform knowledge — declared in
 * the pack's `verification-semantics` entry, compiled here once at the
 * composition root, applied mechanically by the adapter.
 * ------------------------------------------------------------------ */

export interface VerificationPolicy {
  /**
   * A validation error that blocks a save keeps the record-edit surface
   * open (with the error rendered inside it). Once the surface has closed,
   * a lingering alert is not a blocking validation.
   */
  blockingValidationHoldsEditSurfaceOpen: boolean;
  /** The platform's success notification may itself carry `role="alert"`. */
  successNotificationMatchesAlertRole: boolean;
  /** Component identities (class names) of notification regions — never validation evidence. */
  notificationComponentClasses: string[];
  /** ARIA roles that identify notification regions. */
  notificationRoles: string[];
}

/**
 * Conservative default for a platform that declares nothing: no special
 * knowledge, so any visible alert still counts — exactly the generic
 * behaviour an ordinary page had before.
 */
export const DEFAULT_VERIFICATION_POLICY: VerificationPolicy = {
  blockingValidationHoldsEditSurfaceOpen: false,
  successNotificationMatchesAlertRole: false,
  notificationComponentClasses: [],
  notificationRoles: []
};

/** The outcome of a platform-aware validation assessment, with its reasoning. */
export interface ValidationAssessment {
  /** Whether a blocking validation error is genuinely in effect. */
  blocking: boolean;
  /** What was seen and how it was classified, for execution evidence. */
  notes: string[];
}
