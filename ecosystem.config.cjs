module.exports = {
  apps: [
    {
      name: "coding-mcp-chatgpt",
      script: "dist/server.js",
      cwd: "/Users/yapweijun/Documents/GitHub/Coding-MCP-ChatGPT",
      interpreter: "node",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        PORT: "6859",
        HOST: "127.0.0.1",
        PUBLIC_BASE_URL: "https://gmb01.xyz",
        WORKSPACE_ROOT: "/Users/yapweijun/Documents/GitHub/Coding-MCP-ChatGPT",
        SHARE_ROOT: "/Users/yapweijun/Documents/GitHub/Coding-MCP-ChatGPT/.shares",
        PROJECT_ROOT: "/Users/yapweijun/Documents/GitHub/Coding-MCP-ChatGPT/.projects",
        OAUTH_STATE_PATH: "/Users/yapweijun/Documents/GitHub/Coding-MCP-ChatGPT/.state/oauth-state.json",
        MCP_DEV_TOKEN: "7ab16081a4be3afbe35ae9d1cea7f91556b21aa8751b00bb",
        KB_MCP_OAUTH_ENABLED: "1",
        KB_MCP_OAUTH_ISSUER: "https://gmb01.xyz",
        KB_MCP_OAUTH_PASSCODE: "p4zg8dEvHxQ68nsIXSGKQ-x-",
        ADMIN_PASSCODE: "p4zg8dEvHxQ68nsIXSGKQ-x-",
        COMMAND_TIMEOUT_MS: "30000"
      }
    }
  ]
};
