import { serve } from '../../shared/rpc.mjs';
import { createReviewAppConfig } from './config.mjs';
serve(createReviewAppConfig());
