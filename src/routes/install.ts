import { FastifyPluginAsync } from "fastify";
import type { InstallScriptService } from "../services/install-script-service.js";

export type InstallRouteOptions = {
  installScriptService: InstallScriptService;
};

export const installRoutes: FastifyPluginAsync<InstallRouteOptions> = async (fastify, opts) => {
  const { installScriptService } = opts;

  fastify.get<{ Reply: string }>("/install.sh", async (_request, reply) => {
    const script = await installScriptService.getInstallSh();
    // charset=utf-8 is required: the scripts contain UTF-8 box-drawing characters; without it
    // clients (PowerShell, terminals) default to a single-byte codepage and render mojibake.
    reply.header("x-sesori-install-version", script.version).type("text/plain; charset=utf-8").send(script.body);
  });

  fastify.get<{ Reply: string }>("/install.ps1", async (_request, reply) => {
    const script = await installScriptService.getInstallPs1();
    reply.header("x-sesori-install-version", script.version).type("text/plain; charset=utf-8").send(script.body);
  });
};
