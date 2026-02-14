import Anthropic from '@anthropic-ai/sdk';
import { warp } from '@warpmetrics/warp';

export function createClient(apiKey) {
  return warp(new Anthropic({ apiKey }));
}
