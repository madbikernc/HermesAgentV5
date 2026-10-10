#!/bin/bash
# Daily lynis hardening audit. Writes /var/log/lynis-report.dat and /var/log/lynis.log
# itself (lynis's own default paths) -- nothing else to capture here. Always exits 0;
# lynis's own exit code reflects findings, not a crash.
lynis audit system --quiet --no-colors
exit 0
