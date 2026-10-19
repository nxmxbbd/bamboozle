import type {
  AccessoryEventTypes,
  Categories,
  H264Level,
  H264Profile,
  HAPStatus,
  MDNSAdvertiser,
  SRTPCryptoSuites,
  StreamRequestTypes,
} from '@homebridge/hap-nodejs';

// hap-nodejs declares these as ambient const enums, which cannot be read
// under isolated / verbatim module compilation. At runtime they are plain
// objects; test/homekit.test.ts checks these literals against them.
export const CATEGORY_BRIDGE = 2 as Categories;
export const CATEGORY_SENSOR = 10 as Categories;
export const STATUS_COMMUNICATION_FAILURE = -70402 as HAPStatus;
export const ADVERTISER_CIAO = 'ciao' as MDNSAdvertiser;
export const EVENT_PAIRED = 'paired' as AccessoryEventTypes.PAIRED;
export const EVENT_UNPAIRED = 'unpaired' as AccessoryEventTypes.UNPAIRED;

// Camera streaming (same const-enum workaround).
export const CATEGORY_CAMERA = 17 as Categories;
export const SRTP_AES_CM_128_HMAC_SHA1_80 = 0 as SRTPCryptoSuites;
export const H264_PROFILES = [0, 1, 2] as H264Profile[]; // baseline, main, high
export const H264_LEVELS = [0, 1, 2] as H264Level[]; // 3.1, 3.2, 4.0
export const STREAM_START = 'start' as StreamRequestTypes.START;
export const STREAM_RECONFIGURE = 'reconfigure' as StreamRequestTypes.RECONFIGURE;
export const STREAM_STOP = 'stop' as StreamRequestTypes.STOP;
