const path = require("path");

require("dotenv").config({ path: path.join(__dirname, ".env") });
require("dotenv").config({ path: path.join(__dirname, ".env.local"), override: false });

const appDir = __dirname;

module.exports = {
  apps: [
    {
      name: "kgs-purchase-http",
      script: ".next/standalone/server.js",
      args: "-p 3001",
      cwd: appDir,
      env: {
        NODE_ENV: "production",
        PORT: 3001,
        NEXT_PUBLIC_BASE_PATH: process.env.NEXT_PUBLIC_BASE_PATH || "/kgs-purchase",
        NEXT_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_BASE_URL,
        ACUMATICA_BASE_URL: process.env.ACUMATICA_BASE_URL,
        ACUMATICA_USERNAME: process.env.ACUMATICA_USERNAME,
        ACUMATICA_PASSWORD: process.env.ACUMATICA_PASSWORD,
        ACUMATICA_COMPANY: process.env.ACUMATICA_COMPANY,
        ACU_USERNAME: process.env.ACU_USERNAME,
        ACU_PASSWORD: process.env.ACU_PASSWORD,
        ACU_COMPANY: process.env.ACU_COMPANY,
        MYSQL_HOST: process.env.MYSQL_HOST,
        MYSQL_PORT: process.env.MYSQL_PORT,
        MYSQL_USER: process.env.MYSQL_USER,
        MYSQL_PASSWORD: process.env.MYSQL_PASSWORD,
        MYSQL_PURCHASE_DATABASE: process.env.MYSQL_PURCHASE_DATABASE,
        MYSQL_INVENTORY_DATABASE: process.env.MYSQL_INVENTORY_DATABASE,
        INVENTORY_ADMIN_TOKEN: process.env.INVENTORY_ADMIN_TOKEN,
        SYNC_SECRET: process.env.SYNC_SECRET,
        NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
      },
      watch: false,
      autorestart: true,
      max_memory_restart: "900M",
      kill_timeout: 8000,
      listen_timeout: 10000,
      exp_backoff_restart_delay: 2000,
      instances: 1,
      exec_mode: "fork",
      node_args: "--max-old-space-size=1024",
    },
  ],
};
