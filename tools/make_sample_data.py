"""
Makes the fictional sample data for the Org Constellation report.

    python tools/make_sample_data.py          -> data/people.csv

Every name, number and date is invented (fixed random seed, so the file is the same every run).
Rows are people or open roles. Each row points at its manager, so the table is also the org tree.
"""
import csv
import random
from datetime import date, timedelta
from pathlib import Path

random.seed(2026)
OUT = Path(__file__).resolve().parent.parent / "data" / "people.csv"

FIRST = ["Aarav", "Vivaan", "Aditya", "Arjun", "Sai", "Reyansh", "Krishna", "Ishaan", "Rohan", "Kabir", "Ananya", "Diya",
         "Saanvi", "Aadhya", "Kiara", "Myra", "Anika", "Navya", "Ira", "Meera", "Rahul", "Neha", "Priya", "Karan", "Pooja",
         "Vikram", "Sneha", "Amit", "Divya", "Nikhil", "Tanvi", "Siddharth", "Riya", "Manish", "Shreya", "Gaurav", "Isha",
         "Harsh", "Kavya", "Yash", "Aisha", "Farhan", "Zoya", "Imran", "Sara", "Joseph", "Maria", "Arvind", "Lakshmi",
         "Suresh", "Deepa", "Ravi", "Anjali", "Varun", "Nisha", "Tarun", "Pallavi", "Ajay", "Swati", "Rakesh", "Bhavna"]
LAST = ["Sharma", "Verma", "Iyer", "Reddy", "Nair", "Menon", "Gupta", "Patel", "Shah", "Rao", "Kulkarni", "Joshi", "Das",
        "Banerjee", "Mukherjee", "Singh", "Khan", "Fernandes", "D'Souza", "Pillai", "Chopra", "Malhotra", "Bose", "Jain",
        "Agarwal", "Mishra", "Pandey", "Naidu", "Hegde", "Kapoor", "Bhat", "Saxena", "Thomas", "Mathew", "Ghosh"]

LOCATIONS = ["Bengaluru", "Mumbai", "Delhi NCR", "Pune", "Hyderabad", "Chennai", "Remote"]

# team: (head title, where the team mostly sits, [(manager title, ic titles, size range)])
TEAMS = {
    "Engineering": ("VP Engineering", ["Bengaluru", "Pune", "Hyderabad", "Remote"],
                    [("Engineering Manager", ["Software Engineer", "Senior Software Engineer", "QA Engineer"], (6, 10))] * 6),
    "Data & Analytics": ("Head of Data", ["Bengaluru", "Hyderabad", "Remote"],
                         [("Analytics Manager", ["Data Analyst", "BI Developer", "Senior Data Analyst"], (4, 6)),
                          ("Data Engineering Manager", ["Data Engineer", "Senior Data Engineer"], (4, 6))]),
    "Sales": ("Sales Director", ["Mumbai", "Delhi NCR", "Chennai", "Bengaluru"],
              [("Regional Sales Manager", ["Account Executive", "Sales Associate", "Key Account Manager"], (6, 9))] * 5),
    "Customer Success": ("Head of Customer Success", ["Pune", "Chennai", "Remote"],
                         [("Support Lead", ["Support Specialist", "Customer Success Manager"], (5, 8))] * 3),
    "Finance": ("Finance Director", ["Mumbai", "Delhi NCR"],
                [("Finance Manager", ["Accountant", "Financial Analyst", "Payroll Specialist"], (3, 5))] * 2),
    "People": ("Head of People", ["Bengaluru", "Delhi NCR"],
               [("People Partner", ["Recruiter", "People Operations Specialist"], (3, 4))] * 2),
    "Operations": ("Operations Director", ["Mumbai", "Chennai", "Hyderabad", "Delhi NCR"],
                   [("Operations Manager", ["Operations Analyst", "Logistics Coordinator", "Procurement Specialist"], (4, 7))] * 3),
}

# name of each manager's unit, in the same order as the groups above
UNITS = {
    "Engineering": ["Platform", "Mobile apps", "Payments", "Web", "Cloud & infra", "Quality"],
    "Data & Analytics": ["Analytics", "Data engineering"],
    "Sales": ["North sales", "West sales", "South sales", "East sales", "Key accounts"],
    "Customer Success": ["Support desk", "Onboarding", "Customer care"],
    "Finance": ["Accounting", "Financial planning"],
    "People": ["Talent", "People operations"],
    "Operations": ["Logistics", "Procurement", "Facilities"],
}

# annual cost in rupees by level
COST = {"ceo": (9_000_000, 11_000_000), "head": (5_000_000, 7_500_000), "manager": (2_600_000, 4_000_000),
        "senior": (1_800_000, 2_800_000), "ic": (800_000, 1_800_000)}

LEVEL_NAME = {"ceo": "Executive", "head": "Head of team", "manager": "Manager", "senior": "Senior", "ic": "Individual contributor"}

used = set()


def person_name():
    while True:
        n = f"{random.choice(FIRST)} {random.choice(LAST)}"
        if n not in used:
            used.add(n)
            return n


def start(years_back_max):
    return date(2026, 10, 1) - timedelta(days=random.randint(60, int(365 * years_back_max)))


rows = []


def add(pid, manager, name, title, team, unit, location, level, status="Active"):
    lo, hi = COST[level]
    cost = round(random.randint(lo, hi), -4)
    rows.append({"PersonID": pid, "ManagerID": manager or "", "Name": name, "Title": title, "Team": team, "Unit": unit,
                 "Location": location, "Level": LEVEL_NAME[level],
                 "Status": status, "AnnualCost": 0 if status == "Open role" else cost,
                 "BudgetedCost": cost, "StartDate": "" if status == "Open role" else start(9).isoformat()})


n = 1
def next_id():
    global n
    pid = f"P{n:04d}"
    n += 1
    return pid


ceo = next_id()
add(ceo, None, person_name(), "Chief Executive Officer", "Executive", "Leadership", "Mumbai", "ceo")
for team, (head_title, homes, groups) in TEAMS.items():
    head = next_id()
    add(head, ceo, person_name(), head_title, team, f"{team} leadership", homes[0], "head")
    for gi, (mgr_title, ic_titles, (lo, hi)) in enumerate(groups):
        mgr = next_id()
        loc = homes[gi % len(homes)]
        unit = UNITS[team][gi]
        add(mgr, head, person_name(), mgr_title, team, unit, loc, "manager")
        for _ in range(random.randint(lo, hi)):
            pid = next_id()
            title = random.choice(ic_titles)
            level = "senior" if title.startswith("Senior") or "Key Account" in title else "ic"
            r = random.random()
            status = "Open role" if r < 0.05 else ("On leave" if r < 0.11 else "Active")
            # most people sit with their manager; some are remote or elsewhere
            ploc = loc if random.random() < 0.8 else random.choice(homes)
            name = f"Open role - {title}" if status == "Open role" else person_name()
            add(pid, mgr, name, title, team, unit, ploc, level, status)

OUT.parent.mkdir(parents=True, exist_ok=True)
with OUT.open("w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0].keys()), lineterminator="\n")  # same bytes on Windows and Linux
    w.writeheader()
    w.writerows(rows)

filled = [r for r in rows if r["Status"] != "Open role"]
print(f"{len(rows)} rows: {len(filled)} people, {len(rows) - len(filled)} open roles, "
      f"{sum(r['Status'] == 'On leave' for r in rows)} on leave, "
      f"cost Rs {sum(r['AnnualCost'] for r in rows) / 1e7:.1f} Cr a year -> {OUT}")
