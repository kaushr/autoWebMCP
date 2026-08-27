import type { BindingValidator } from "../validation";
import { salesforceRecordUpdateValidator } from "./salesforce";

/**
 * Validators, most specific first. An application with no validator produces an
 * inconclusive result rather than an attempt at something unsupported.
 */
export const defaultValidators: readonly BindingValidator[] = [salesforceRecordUpdateValidator];
