import { FINAL_VERIFICATION_NUDGE } from "../../../prompts/finalVerification.ts";
import type { SystemNotification } from "./SystemNotification.ts";

/**
 * One visible verification phase for successful changes lacking validation.
 * Read/search volume and plan metadata never justify another model request.
 */
export function finalVerificationNotification(
	enabled: boolean,
): SystemNotification {
	return {
		id: "final-verification",
		supersedesFinalAnswer: true,
		hidesResponse: false,
		shouldFire: (context) => {
			const evidence = context.completionEvidence;
			return (
				enabled &&
				context.requestKind === "user" &&
				evidence !== undefined &&
				evidence.successfulMutations > 0 &&
				(evidence.unvalidatedMutations > 0 || evidence.validationFailed)
			);
		},
		content: () => FINAL_VERIFICATION_NUDGE,
	};
}
