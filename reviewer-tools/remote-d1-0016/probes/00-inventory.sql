SELECT type, name, tbl_name, length(replace(COALESCE(sql, ''), char(13), '')) AS sql_len
FROM sqlite_master
WHERE name NOT LIKE '!_cf!_%' ESCAPE '!' AND name NOT LIKE 'sqlite!_stat%' ESCAPE '!'
ORDER BY type, name;
