import { expect, test } from "vitest";

import {
  CHUNK_VECTOR_READ_BIND_PARAMETER_BATCH_SIZE,
  buildChunkVectorBatchReadQuery,
} from "../../src/star/chunk-vector-batch.js";

test("chunk vector batch owner builds the canonical bounded read query", () => {
  expect(CHUNK_VECTOR_READ_BIND_PARAMETER_BATCH_SIZE).toBe(900);
  expect(buildChunkVectorBatchReadQuery(3)).toContain("WHERE c.id IN (?, ?, ?)");
  expect(buildChunkVectorBatchReadQuery(3)).toContain("INNER JOIN chunks_vec v ON c.rowid = v.rowid");
  expect(() => buildChunkVectorBatchReadQuery(0)).toThrow(/candidate count/i);
  expect(() => buildChunkVectorBatchReadQuery(901)).toThrow(/candidate count/i);
});
