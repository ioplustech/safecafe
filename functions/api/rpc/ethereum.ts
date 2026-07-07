import { handleEthereumRpcGatewayRequest, type RpcGatewayEnv } from "../../../src/server/rpcGateway"

export const onRequestPost: PagesFunction<RpcGatewayEnv> = async ({ request, env }) =>
  handleEthereumRpcGatewayRequest(request, env)

export const onRequestGet: PagesFunction<RpcGatewayEnv> = async ({ request, env }) =>
  handleEthereumRpcGatewayRequest(request, env)
