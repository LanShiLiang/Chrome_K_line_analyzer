import type { EvidenceCode, TradeAction, VolumeLabel, WyckoffStage } from '../core/model/types';
import type { MarketSite } from '../core/adapter/sites';
import type { MessageKey } from '../shared/i18n-types';

export const ACTION_MESSAGE_KEYS: Record<TradeAction, MessageKey> = {
  BUY: 'action_buy',
  SELL: 'action_sell',
  HOLD: 'action_hold',
  RISK: 'action_risk',
};

export const STAGE_MESSAGE_KEYS: Record<WyckoffStage, MessageKey> = {
  ACCUMULATION: 'stage_accumulation',
  SPRING_TEST: 'stage_spring_test',
  MARKUP: 'stage_markup',
  DISTRIBUTION: 'stage_distribution',
  MARKDOWN: 'stage_markdown',
  UNKNOWN: 'stage_unknown',
};

export const VOLUME_MESSAGE_KEYS: Record<VolumeLabel, MessageKey> = {
  SPIKE: 'volume_spike',
  LOW: 'volume_low',
  NORMAL: 'volume_normal',
};

export const EVIDENCE_MESSAGE_KEYS: Record<
  EvidenceCode,
  { label: MessageKey; detail: MessageKey }
> = {
  PRICE_ONLY: {
    label: 'evidence_price_only_label',
    detail: 'evidence_price_only_detail',
  },
  B003: { label: 'evidence_b003_label', detail: 'evidence_b003_detail' },
  S003: { label: 'evidence_s003_label', detail: 'evidence_s003_detail' },
  B001: { label: 'evidence_b001_label', detail: 'evidence_b001_detail' },
  S002: { label: 'evidence_s002_label', detail: 'evidence_s002_detail' },
  B004: { label: 'evidence_b004_label', detail: 'evidence_b004_detail' },
  TREND_UP: { label: 'evidence_trend_up_label', detail: 'evidence_trend_up_detail' },
  TREND_DOWN: { label: 'evidence_trend_down_label', detail: 'evidence_trend_down_detail' },
};

export const SITE_MESSAGE_KEYS: Partial<Record<MarketSite, MessageKey>> = {
  binance: 'site_binance',
  tonghuashun: 'site_tonghuashun',
  tradingview: 'site_tradingview',
};
