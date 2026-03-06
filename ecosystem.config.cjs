module.exports = {
  apps: [
    {
      name: "orbita-keeper",
      script: "./run-local.sh",
      // Execute as a bash script
      interpreter: "bash",
      // Run every 1 minute like a cron job
      cron_restart: "*/1 * * * *",
      // Don't auto-restart immediately when it finishes (wait for cron)
      autorestart: false,
      // Useful for tracking when liquidations happened
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      error_file: "./logs/error.log",
      out_file: "./logs/output.log",
    },
  ],
};
