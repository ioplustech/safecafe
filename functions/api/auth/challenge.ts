import { handleRpcChallengeRequest, type RpcGatewayEnv } from "../../../src/server/rpcGateway"

export const onRequestPost: PagesFunction<RpcGatewayEnv> = async ({ request, env }) =>
  handleRpcChallengeRequest(request, env)

export const onRequestGet: PagesFunction<RpcGatewayEnv> = async ({ request, env }) =>
  handleRpcChallengeRequest(request, env)
