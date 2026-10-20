// Where each painting sits on the shared 1536x864 canvas (Locus, and Vaita in the robe her world wears), the robe
// each world wears, and each plate: the HD files only (the launch page and imperfect OS's lock draw nothing else). Written
// by scripts/build-assets.mjs, then trimmed to what is drawn.
export default {
  "canvas": [
    1536,
    864
  ],
  "contact": [
    872.5,
    175.5
  ],
  "locus": {
    "hd": "assets/hd/locus.webp",
    "crop": [
      158,
      166,
      723,
      661
    ],
    "box": [
      166,
      174,
      873,
      819
    ]
  },
  "vaitas": {
    "wool": {
      "hd": "assets/hd/vaita-dragon.webp",
      "crop": [
        861,
        16,
        638,
        533
      ],
      "box": [
        869,
        24,
        1491,
        541
      ]
    }
  },
  "worlds": {
    "dragon": {
      "vaita": "wool",
      "land": {
        "size": [
          1536,
          864
        ],
        "focus": [
          872.5,
          175.5
        ],
        "hd": "assets/hd/worlds/dragon.webp"
      },
      "port": {
        "size": [
          941,
          1672
        ],
        "focus": [
          470.5,
          568
        ],
        "hd": "assets/hd/worlds/portrait-dragon.webp"
      }
    }
  },
  "hd": {
    "backgrounds": "GPT Image 2.5 Sunburst restoration; landscape 3840x2160, portrait 2160x3840",
    "upscaler": "Characters: Real-ESRGAN ncnn-vulkan, realesrgan-x4plus, 4x then 2x",
    "esrganShare": 0.55,
    "blend": "luminance only, colour from Lanczos"
  }
};
