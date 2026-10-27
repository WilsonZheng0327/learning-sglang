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
export const VOCAB = 128256;         // tokens in the vocabulary
export const BYTES = 2;              // bf16

// k and v for one token, across the model: 128 KB (chapter 3)
export const KB_PER_TOKEN = (LAYERS * KV_HEADS * HEAD_DIM * 2 * BYTES) / 1024;

// the Omni running example (chapters 16–21): Qwen3-Omni as SGLang-Omni serves it
export const SPEECH_IN_HZ = 16000;     // audio samples a second the model reads
export const SPEECH_OUT_HZ = 24000;    // audio samples a second the model writes
export const VISION_PATCH = 16;        // pixels a side per patch
export const VISION_MERGE = 2;         // patches merged 2 × 2 into one prompt position
export const AUDIO_FRAMES_PER_SEC = 100;   // feature frames the audio encoder reads a second
export const AUDIO_POS_PER_100 = 13;       // prompt positions per 100 feature frames
export const CODES_PER_FRAME = 16;         // speech out: codes that describe one frame of sound
export const CODE_VALUES = 2048;           // each code is one of 2,048 values
export const SAMPLES_PER_FRAME = 1920;     // sound samples the codec writes per frame (8 · 5 · 4 · 3 · 2 · 2)
export const OMNI_HIDDEN = 2048;           // the thinker's width: numbers in one token's vector (and in one encoder embedding)
// Qwen3-Omni's parameters, in billions, counted from its checkpoint; × BYTES for its bf16 weights in GB.
// The talker's count includes its code predictor.
export const OMNI_PARAMS_B = { thinker: 30.5, talker: 3.3, audio: 0.65, vision: 0.54, code2wav: 0.22 };
// the thinker's attention: k and v for one token, across its layers, is 96 KB
export const OMNI_LAYERS = 48;
export const OMNI_KV_HEADS = 4;
export const OMNI_KB_PER_TOKEN = (OMNI_LAYERS * OMNI_KV_HEADS * HEAD_DIM * 2 * BYTES) / 1024;
