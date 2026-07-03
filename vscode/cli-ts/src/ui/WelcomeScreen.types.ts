export interface WelcomeScreenProps {
	cwd: string;
	model: string;
	mcpServerCount: number;
	onContinue: () => void;
}
