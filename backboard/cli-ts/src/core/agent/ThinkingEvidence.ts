export function hasStructuralDiagnosticText(text: string): boolean {
	return DIAGNOSTIC_PATTERNS.some((pattern) => pattern.test(text));
}

const DIAGNOSTIC_PATTERNS: readonly RegExp[] = [
	/\bTraceback \(most recent call last\):/,
	/\bat .+:\d+:\d+\)?/,
	/\b\w+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|swift|c|cc|cpp|h|hpp):\d+(?::\d+)?\b/,
	/\b(?:FAIL|FAILED|Error):\s+[^\n]+/,
	/\bexit code:\s*[1-9]\d*\b/i,
	/```[\s\S]{0,2000}\bexit code:\s*[1-9]\d*\b[\s\S]{0,2000}```/i,
];

/** Conservative fast path for explicitly narrow work; uncertainty keeps medium. */
export function isRoutineTask(content: string): boolean {
	if (
		content.length > 800 ||
		/\b(debug|architect|design|investigat|analy[sz]|security|migrat|race|deadlock|performance)\w*/i.test(
			content,
		)
	)
		return false;
	return /\b(read|show|list|find|locate|search|grep|glob|rename|typo|spelling|format)\b/i.test(
		content,
	);
}
