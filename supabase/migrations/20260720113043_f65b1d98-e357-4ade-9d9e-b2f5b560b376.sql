SELECT vault.update_secret(
  (SELECT id FROM vault.secrets WHERE name = 'CRON_SECRET'),
  'Ph8oIO0KYs5T_lHptzmnE6LXFgtG5gp-hPmR5Vu3yQU'
);