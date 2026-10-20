// Where the bones are in each painting, which paint each bone moves, and how far each limb starts from its
// painted pose. All positions are painted pixels on the shared 1536x864 canvas (x right, y down); angles are
// degrees, positive clockwise on screen. The painted pose is the contact pose: every angle eases to 0 there.
//
// A chain's region is a polygon with a soft edge: paint well inside moves fully with the chain, paint well outside
// stays with the body, and the band where the edge crosses the limb's root is where it bends. "keep" shapes
// never take weight from that chain; a figure's keep applies to ALL chains. layer > 0 draws the chain in front
// of the body, < 0 behind.

export const LOCUS = {
  name: 'locus',
  order: 2,                       // drawn over Vaita, as in the approved end pose
  grid: 6,
  pivot: [470, 500],              // the body's centre: roll, yaw and drift turn about it
  chains: [
    {
      name: 'arm',                // his LEFT arm, the wand hand: the far arm, so it hangs behind his body
      layer: -1,
      soft: 17,
      joints: [
        { name: 'shoulder', at: [581, 394] },
        { name: 'elbow', at: [658, 357], band: 22 },
        { name: 'wrist', at: [736, 306], band: 8 },
      ],
      end: [762, 287],            // the hand: the wrist's cut faces it, and the wand is rigid with it
      // the first edge is the cut across the arm's root, perpendicular to the upper arm, starting below the beard
      region: [[576, 376], [614, 441], [700, 398], [792, 346], [930, 196], [905, 128], [850, 128], [785, 228], [700, 262], [640, 300], [606, 338]],
      keep: [{ at: [518, 316], r: [62, 58] }, { at: [556, 357], r: [25, 18] }],   // his face, hair and beard never move with the arm
    },
    {
      name: 'leg',                // the front, knee-up leg; it sits in front of the back leg
      layer: 1,
      soft: 12,                  // original leg bend; only the held laptop is protected
      joints: [
        { name: 'hip', at: [410, 594] },
        { name: 'knee', at: [578, 534], band: 22 },
      ],
      end: [470, 690],            // the ankle: the knee's cut faces down the shin
      region: [[392, 552], [446, 540], [500, 526], [552, 510], [606, 488], [648, 540], [630, 615], [585, 682], [535, 700], [528, 782], [415, 784], [412, 700], [436, 656], [420, 642], [396, 637], [380, 602]],
      keep: [{ at: [398, 468], r: [78, 70] }],
    },
  ],
  sway: {                         // only the loose coat tails; the shoulder, carrying sleeve and trousers stay put
    region: [[166, 582], [260, 567], [306, 552], [333, 575], [321, 611], [300, 650], [295, 689], [236, 665], [211, 619], [170, 635]],
    soft: 16,
    keep: [
      // Fade into the fixed coat root below the carrying arm, not into the sleeve or torso.
      { polygon: [[290, 350], [620, 350], [620, 578], [350, 578], [310, 550], [290, 520]], margin: 12, soft: 16 },
      // The back trousers share the coat's lower silhouette; they must not flutter with its hem.
      { polygon: [[215, 706], [294, 686], [342, 628], [400, 610], [440, 634], [370, 718], [260, 792], [190, 825], [168, 795]], margin: 8, soft: 12 },
    ],
  },
  tip: [872.5, 175.5],            // the Elder Wand's tip
};

export const VAITA = {
  name: 'vaita',
  order: 1,
  grid: 6,
  pivot: [1180, 270],
  chains: [
    {
      name: 'arm',                // her reaching arm, in its wide fur sleeve; in front of her hood when raised
      layer: 1,
      soft: 16,
      joints: [
        { name: 'shoulder', at: [1020, 158] },
        { name: 'elbow', at: [962, 165], band: 24 },
        { name: 'wrist', at: [931, 168], band: 9 },
      ],
      end: [890, 172],
      region: [[1034, 112], [1032, 168], [1022, 214], [1004, 270], [930, 285], [880, 240], [845, 205], [845, 135], [900, 100], [965, 92]],
      keep: [{ at: [1066, 98], r: [30, 46] }],   // her face inside the hood
    },
  ],
  sway: {                         // the open robe's free hem drifts a little while she floats in; never hood, face, hands
    region: [[1352, 284], [1520, 300], [1520, 500], [1352, 500], [1322, 392]],
    soft: 55,
    keep: [{ at: [1298, 238], r: [26, 26] }, { at: [1282, 480], r: [46, 70] }],
  },
  tip: [872.5, 175.5],            // her fingertip, where the wand touches
};

// The original start pose, as angles; the opener now begins part-way from these (timeline.mjs POSE_FROM), and all
// reach 0 at the contact.
export const START = {
  locus: { arm: [96, -6, 30], leg: [30, 12] },   // wand arm down by his side, wand pointing down; front leg trailing
  vaita: { arm: [80, 18, 8] },                     // reaching arm raised high, above her hood
};
