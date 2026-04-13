"""Compute modules — one per demo, each exporting a build_*() function.

Every function takes (db: Session, pack) and returns the template context
dict. The seeder deposits raw data into DB tables; these modules query it
and compute results at request time.
"""
