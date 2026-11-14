// Two-database retention: preserve a verifiable knowledge archive before deleting board and ledger rows.
export class Retention {
  constructor(scheduler, knowledge) {
    this.scheduler = scheduler
    this.knowledge = knowledge
  }

  run({ rooms } = {}) {
    const done = []
    for (const insight of this.scheduler.consolidatedPlans()) {
      this.knowledge.stageSources(insight.room, insight.planId, this.scheduler.noteSources(insight.planId))
      this.knowledge.addInsight(insight)
    }
    this.knowledge.syncPublications()
    if (rooms) {
      for (const row of this.scheduler.orphanPlans(rooms)) {
        if (row.status === 'completed' && this.scheduler.planInsight(row.plan_id)) {
          const snapshot = this.scheduler.archiveSnapshot(row.plan_id)
          this.knowledge.archive(snapshot)
          if (!this.knowledge.archived(row.plan_id, snapshot.marks)) throw new Error('archive_incomplete')
          this.scheduler.deleteCards(row.plan_id)
          this.scheduler.deletePlanDetails(row.plan_id)
          done.push({ planId: row.plan_id, status: 'archived' })
        } else {
          this.scheduler.cancelOrphan(row.plan_id)
        }
      }
    }
    for (const row of this.scheduler.cancelledPlans()) {
      this.knowledge.purgePlan(row.plan_id)
      this.scheduler.deleteCards(row.plan_id)
      this.scheduler.deletePlanDetails(row.plan_id)
      done.push({ planId: row.plan_id, status: 'removed' })
    }
    for (const row of this.scheduler.retentionCandidates()) {
      const snapshot = this.scheduler.archiveSnapshot(row.plan_id)
      this.knowledge.archive(snapshot)
      if (!this.knowledge.archived(row.plan_id, snapshot.marks)) throw new Error('archive_incomplete')
      this.scheduler.deleteCards(row.plan_id)
      this.scheduler.deletePlanDetails(row.plan_id)
      done.push({ planId: row.plan_id, status: 'archived' })
    }
    return done
  }
}
