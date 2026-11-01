UPDATE "Competition" SET "name" = "name" || ' — qualification' WHERE "ftlEventId" = 'ENGARDE:cerclescrimepam/ehs_2026/qualif' AND "name" NOT LIKE '%qualification';
