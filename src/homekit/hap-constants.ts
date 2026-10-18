import type { AccessoryEventTypes, Categories, HAPStatus, MDNSAdvertiser } from 'hap-nodejs';

// hap-nodejs declares these as ambient const enums, which cannot be read
// under isolated / verbatim module compilation. At runtime they are plain
// objects; test/hap-constants.test.ts checks these literals against them.
export const CATEGORY_BRIDGE = 2 as Categories;
export const CATEGORY_SENSOR = 10 as Categories;
export const STATUS_COMMUNICATION_FAILURE = -70402 as HAPStatus;
export const ADVERTISER_CIAO = 'ciao' as MDNSAdvertiser;
export const EVENT_PAIRED = 'paired' as AccessoryEventTypes.PAIRED;
export const EVENT_UNPAIRED = 'unpaired' as AccessoryEventTypes.UNPAIRED;
