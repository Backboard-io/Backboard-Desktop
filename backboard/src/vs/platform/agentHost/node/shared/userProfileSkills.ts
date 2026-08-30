/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';

export interface IUserProfileSkillLocations {
	/** Plugin-shaped root consumed by Claude (`<root>/skills/<name>/SKILL.md`). */
	readonly agentsRoot: URI;
	/** Skill collection root consumed directly by Codex and Backboard. */
	readonly skillsRoot: URI;
}

/**
 * Resolve the shared Agent Skills directory in the user's profile.
 *
 * `~/.agents/skills` is the provider-neutral location used by the IDE. It is
 * added alongside each provider's native locations (`~/.claude/skills`,
 * `~/.codex/skills`, and so on), never in place of them.
 */
export function resolveUserProfileSkillLocations(
	userHome = homedir(),
	pathExists: (path: string) => boolean = existsSync,
): IUserProfileSkillLocations | undefined {
	const agentsRootPath = join(userHome, '.agents');
	const skillsRootPath = join(agentsRootPath, 'skills');
	if (!pathExists(skillsRootPath)) {
		return undefined;
	}
	return {
		agentsRoot: URI.file(agentsRootPath),
		skillsRoot: URI.file(skillsRootPath),
	};
}
