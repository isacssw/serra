// The three words a pairing shows on both sides (ux-rules F5). They come from the server certificate's fingerprint,
// so the Mac and `serra server pair` show the same three only when the Mac reached the real server: a machine in the
// middle has another certificate, and other words. The Mac sends nothing secret until the owner says they match.
import { createHash } from 'node:crypto';

/** 256 short, common, easy-to-say words that don't look or sound alike, so one byte picks one. */
const WORDS: readonly string[] = [
  'acorn', 'adobe', 'agent', 'alarm', 'album', 'alpha', 'amber', 'anchor', 'angle', 'apple', 'apron', 'arena', 'arrow', 'aspen', 'atlas', 'attic',
  'autumn', 'avenue', 'bacon', 'badge', 'bagel', 'baker', 'balloon', 'bamboo', 'banjo', 'barley', 'basil', 'basket', 'beacon', 'beaver', 'berry', 'bishop',
  'blanket', 'blossom', 'bonsai', 'border', 'bottle', 'bracket', 'branch', 'breeze', 'brick', 'bridge', 'bronze', 'bubble', 'bucket', 'buffalo', 'bugle', 'butter',
  'cabin', 'cactus', 'camera', 'canal', 'candle', 'canoe', 'canyon', 'carbon', 'carpet', 'carrot', 'castle', 'cedar', 'cello', 'cherry', 'chess', 'circle',
  'citrus', 'clover', 'cobalt', 'cocoa', 'comet', 'compass', 'copper', 'coral', 'cotton', 'cradle', 'crayon', 'cricket', 'crystal', 'cupcake', 'cypress', 'daisy',
  'dancer', 'delta', 'desert', 'diamond', 'dolphin', 'domino', 'donkey', 'dragon', 'drum', 'eagle', 'easel', 'echo', 'eclipse', 'elbow', 'ember', 'engine',
  'falcon', 'feather', 'fennel', 'ferry', 'fiddle', 'flame', 'flute', 'forest', 'fossil', 'fountain', 'galaxy', 'garden', 'garlic', 'geyser', 'ginger', 'glacier',
  'goblet', 'gopher', 'granite', 'grape', 'gravel', 'guitar', 'hammer', 'harbor', 'harvest', 'hazel', 'helmet', 'heron', 'hickory', 'honey', 'horizon', 'husky',
  'igloo', 'island', 'ivory', 'jacket', 'jaguar', 'jasmine', 'jelly', 'jigsaw', 'jungle', 'juniper', 'kayak', 'kernel', 'kettle', 'kitten', 'koala', 'ladder',
  'lagoon', 'lantern', 'laurel', 'lemon', 'lentil', 'library', 'lilac', 'lizard', 'lobster', 'locket', 'lotus', 'magnet', 'mango', 'maple', 'marble', 'meadow',
  'melon', 'meteor', 'mitten', 'monsoon', 'mosaic', 'muffin', 'nectar', 'needle', 'noodle', 'nutmeg', 'oasis', 'ocean', 'octopus', 'olive', 'onion', 'orbit',
  'orchid', 'otter', 'oyster', 'paddle', 'panda', 'paper', 'parrot', 'pebble', 'pepper', 'piano', 'pickle', 'pigeon', 'pillow', 'pine', 'planet', 'plum',
  'pocket', 'pollen', 'poppy', 'potato', 'pretzel', 'prism', 'puffin', 'pumpkin', 'quartz', 'quill', 'rabbit', 'radish', 'raven', 'ribbon', 'river', 'robin',
  'rocket', 'saddle', 'saffron', 'salmon', 'sapphire', 'satchel', 'scarf', 'shadow', 'shell', 'sierra', 'silver', 'sketch', 'sparrow', 'spinach', 'spruce', 'squash',
  'summit', 'sunset', 'swan', 'tablet', 'tango', 'teapot', 'thimble', 'thistle', 'thunder', 'tiger', 'timber', 'tomato', 'topaz', 'trumpet', 'tulip', 'tunnel',
  'turnip', 'turtle', 'umbrella', 'valley', 'velvet', 'violin', 'walnut', 'walrus', 'wander', 'whistle', 'willow', 'window', 'winter', 'yogurt', 'zebra', 'zephyr',
];

/** The three words for a certificate fingerprint (`sha256:…`). */
export const pairingWords = (fingerprint: string): [string, string, string] => {
  const digest = createHash('sha256').update(`serra-pair-words\0${fingerprint}`).digest();
  return [WORDS[digest[0]!]!, WORDS[digest[1]!]!, WORDS[digest[2]!]!];
};
