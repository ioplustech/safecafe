import { handleRpcVerifyRequest, type RpcGatewayEnv } from "../../../src/server/rpcGateway"

export const onRequestPost: PagesFunction<RpcGatewayEnv> = async ({ request, env }) =>
  handleRpcVerifyRequest(request, env)

export const onRequestGet: PagesFunction<RpcGatewayEnv> = async ({ request, env }) =>
  handleRpcVerifyRequest(request, env)
