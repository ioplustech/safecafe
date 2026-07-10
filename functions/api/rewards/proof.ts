import { handleRewardProofRequest } from "../../../src/server/rewardsProof"
import type { RpcGatewayEnv } from "../../../src/server/serverEnv"

export const onRequestGet: PagesFunction<RpcGatewayEnv> = async ({ env, request }) =>
  handleRewardProofRequest(request, env)

export const onRequestPost: PagesFunction<RpcGatewayEnv> = async ({ env, request }) =>
  handleRewardProofRequest(request, env)
