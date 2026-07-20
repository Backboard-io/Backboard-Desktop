/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A point in either screen (viewport) or world (canvas) coordinates. Which space
 * a given point is expressed in is determined by the API that produces or
 * consumes it (see {@link IJarvisCamera}, `screenToWorld`, `worldToScreen`).
 */
export interface IJarvisPoint {
	readonly x: number;
	readonly y: number;
}

/**
 * An axis-aligned rectangle in world (canvas) coordinates. Used for card
 * geometry: `x`/`y` are the top-left corner, `width`/`height` the size.
 */
export interface IJarvisRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/**
 * The canvas camera: the world-space point mapped to the viewport origin
 * (`x`/`y`) plus a uniform `zoom` factor. Screen and world coordinates relate
 * by `screen = (world - camera) * zoom`.
 */
export interface IJarvisCamera {
	readonly x: number;
	readonly y: number;
	readonly zoom: number;
}
