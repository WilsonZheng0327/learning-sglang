// The book's running example, shared by every chapter so a number means the same thing everywhere:
// Llama-3-8B in bf16 on one H100 SXM. Derive from these rather than typing results, so a change propagates.

// the GPU
export const HBM_GB = 80;            // memory
export const BW = 3.35;              // HBM bandwidth, TB/s
export const TFLOPS = 989;           // dense bf16 math, TFLOP/s
export const SMS = 132;              // streaming multiprocessors

// the model
export const W_GB = 16;              // weights
export const GFLOP_PER_TOKEN = 16;   // ≈ 2 × 8B parameters
export const LAYERS = 32;
export const HEADS = 32;             // query heads
export const KV_HEADS = 8;           // grouped-query attention: 4 query heads per K/V head
export const HEAD_DIM = 128;
export const D_MODEL = 4096;
export const D_FF = 14336;
export const BYTES = 2;              // bf16

// k and v for one token, across the model: 128 KB (chapter 3)
export const KB_PER_TOKEN = (LAYERS * KV_HEADS * HEAD_DIM * 2 * BYTES) / 1024;
