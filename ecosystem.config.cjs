module.exports = {
  apps: [{
    name: "polysignal",
    script: "src/server.js",
    env_production: {
      NODE_ENV: "production"
    },
    max_memory_restart: "200M",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    error_file: "./logs/pm2-error.log",
    out_file: "./logs/pm2-out.log",
    merge_logs: true,
    autorestart: true,
    watch: false
  }]
};
