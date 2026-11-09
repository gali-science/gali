import { expect, test } from "vitest";
import {
  fitLookDimensions,
  LOOK_MAX_SIDE,
  mapDisplayRectToImage,
  normalizeSelectionRect,
} from "./selection-rect";

test("normalizeSelectionRect orders points and rejects tiny drags", () => {
  expect(
    normalizeSelectionRect({ x: 40, y: 50 }, { x: 10, y: 20 }, { width: 200, height: 100 }),
  ).toEqual({ x: 10, y: 20, width: 30, height: 30 });
  expect(
    normalizeSelectionRect({ x: 10, y: 10 }, { x: 12, y: 12 }, { width: 200, height: 100 }),
  ).toBeNull();
});

test("normalizeSelectionRect clamps to bounds", () => {
  expect(
    normalizeSelectionRect({ x: -20, y: -10 }, { x: 250, y: 180 }, { width: 200, height: 100 }),
  ).toEqual({ x: 0, y: 0, width: 200, height: 100 });
});

test("mapDisplayRectToImage scales into capture pixels", () => {
  expect(
    mapDisplayRectToImage(
      { x: 10, y: 20, width: 40, height: 30 },
      { width: 100, height: 100 },
      { width: 200, height: 400 },
    ),
  ).toEqual({ x: 20, y: 80, width: 80, height: 120 });
});

test("mapDisplayRectToImage clamps to image bounds", () => {
  expect(
    mapDisplayRectToImage(
      { x: 90, y: 90, width: 20, height: 20 },
      { width: 100, height: 100 },
      { width: 100, height: 100 },
    ),
  ).toEqual({ x: 90, y: 90, width: 10, height: 10 });
});

test("fitLookDimensions keeps small crops unchanged", () => {
  expect(fitLookDimensions(800, 600)).toEqual({ width: 800, height: 600 });
});

test("fitLookDimensions scales down by longest side", () => {
  expect(fitLookDimensions(4096, 2048)).toEqual({
    width: LOOK_MAX_SIDE,
    height: Math.round((2048 * LOOK_MAX_SIDE) / 4096),
  });
  expect(fitLookDimensions(1000, 4000)).toEqual({
    width: Math.round((1000 * LOOK_MAX_SIDE) / 4000),
    height: LOOK_MAX_SIDE,
  });
});
