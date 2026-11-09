import { expect, test } from "vitest";
import { buildArboristData } from "./file-tree-data";

test("nests folders and sorts directories before files", () => {
  const tree = buildArboristData([
    { path: "README.md", kind: "text", binary: false, bytes: 10 },
    { path: "src/lib.py", kind: "text", binary: false, bytes: 20 },
    { path: "src/experiments/sgd.py", kind: "text", binary: false, bytes: 30 },
  ]);

  expect(tree.map((node) => node.name)).toEqual(["src", "README.md"]);
  expect(tree[0]!.children?.map((node) => node.name)).toEqual(["experiments", "lib.py"]);
  expect(tree[0]!.children?.[0]!.children?.map((node) => node.name)).toEqual(["sgd.py"]);
  expect(tree[0]!.children?.[0]!.children?.[0]!.path).toBe("src/experiments/sgd.py");
});
