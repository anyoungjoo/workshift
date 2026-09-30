// 송출근무표 기본 표준 데이터 (Default Baseline Data)
// 새 기기/새 사용자가 처음 실행하거나 오프라인일 때도 현재 최신 상태를 100% 동일하게 유지하도록 보장하는 기준 데이터

const DEFAULT_BASELINE_MEMBERS = [
  {
    "phone": "010-4553-1209",
    "name": "이준희",
    "empNo": "16607",
    "id": 0,
    "email": "juni1209@kbs.co.kr",
    "baseShift": "일"
  },
  {
    "email": "mypine@kbs.co.kr",
    "name": "안영주",
    "id": 1,
    "baseShift": "야",
    "phone": "010-4353-3461",
    "empNo": "17300"
  },
  {
    "id": 2,
    "baseShift": "조",
    "empNo": "16456",
    "phone": "010-8801-9605",
    "name": "오승연",
    "email": "thinkagain21@naver.com"
  },
  {
    "empNo": "30594",
    "id": 3,
    "phone": "010-4061-5470",
    "baseShift": "비",
    "name": "최혜진",
    "email": "choi2@kbs.co.kr"
  }
];

const DEFAULT_BASELINE_CHIEF = {
  name: "우건제",
  empNo: "20133",
  phone: "010-6368-6945",
  email: "kjwoo@kbs.co.kr"
};

const DEFAULT_BASELINE_MAINT_MEMBERS = [
  {
    "email": "8sss3@kbs.co.kr",
    "role": "송신소",
    "empNo": "31163",
    "name": "조성기",
    "phone": "010-6458-559701",
    "id": 0
  },
  {
    "email": "sik@kbs.co.kr",
    "role": "송신소",
    "empNo": "34314",
    "name": "정현식",
    "id": 1,
    "phone": "010-6776-5009"
  },
  {
    "role": "TVR",
    "empNo": "33907",
    "phone": "010-9012-1364",
    "id": 2,
    "email": "",
    "name": "김천일"
  },
  {
    "phone": "010-4462-8475",
    "name": "이명준",
    "empNo": "34382",
    "email": "",
    "id": 3,
    "role": "TVR"
  }
];

const DEFAULT_BASELINE_LEAVES = {
  "2026-09-25": {
    "최혜진": {
      "subMemberName": null,
      "isManual": false,
      "leaveType": "전일",
      "isLeave": true,
      "memberName": "최혜진",
      "customSubName": null,
      "subId": null
    }
  },
  "2026-09-24": {
    "최혜���": {
      "subMemberName": null,
      "isLeave": true,
      "leaveType": "전일",
      "isManual": false,
      "subId": null,
      "memberName": "최혜진",
      "customSubName": null
    }
  },
  "2026-09-23": {
    "최혜진": {
      "isLeave": true,
      "subMemberName": null,
      "leaveType": "��일",
      "subId": null,
      "memberName": "최혜진",
      "isManual": false,
      "customSubName": null
    }
  },
  "2026-09-16": {
    "이준희": {
      "subId": null,
      "memberName": "이준희",
      "isManual": false,
      "leaveType": "전일",
      "subMemberName": null,
      "isLeave": true,
      "customSubName": null
    }
  },
  "2026-10-03": {
    "최혜진": {
      "isManual": false,
      "memberName": "최혜진",
      "leaveType": "전일",
      "subMemberName": null,
      "isLeave": true,
      "subId": null,
      "customSubName": null
    }
  },
  "2026-10-01": {
    "최혜진": {
      "subId": null,
      "isLeave": true,
      "customSubName": null,
      "leaveType": "전일",
      "memberName": "최혜진",
      "isManual": false,
      "subMemberName": null
    }
  },
  "2026-09-28": {
    "최혜진": {
      "customSubName": "정현식",
      "memberName": "최혜진",
      "leaveType": "전일",
      "isManual": true,
      "subMemberName": "정현식",
      "isLeave": true,
      "subId": "CUSTOM"
    },
    "오승연": {
      "customSubName": "우건제",
      "isManual": true,
      "leaveType": "오후반차",
      "isLeave": true,
      "memberName": "오승연",
      "subId": "CUSTOM",
      "subMemberName": "우건제"
    }
  },
  "2026-09-29": {
    "최혜진": {
      "isManual": true,
      "memberName": "최혜진",
      "customSubName": "정현식",
      "subId": "CUSTOM",
      "leaveType": "전일",
      "subMemberName": "정현식",
      "isLeave": true
    }
  },
  "2026-09-15": {
    "이준희": {
      "subMemberName": "안영주",
      "isLeave": true,
      "customSubName": null,
      "leaveType": "전일",
      "isManual": true,
      "memberName": "이준희",
      "subId": 1
    }
  },
  "2026-09-27": {
    "최혜진": {
      "subMemberName": null,
      "isLeave": true,
      "leaveType": "전일",
      "isManual": false,
      "memberName": "최혜진",
      "customSubName": null,
      "subId": null
    }
  },
  "2026-10-02": {
    "최혜진": {
      "isLeave": true,
      "leaveType": "전일",
      "isManual": false,
      "memberName": "최혜진",
      "customSubName": null,
      "subId": null,
      "subMemberName": null
    }
  }
};

const DEFAULT_BASELINE_PERSON_CONTACTS = {
  "주성기": {
    "empNo": "31163",
    "email": "8sss3@kbs.co.kr",
    "phone": "010-6458-559701"
  },
  "이준희": {
    "empNo": "16607",
    "email": "juni1209@kbs.co.kr",
    "phone": "010-4553-1209"
  },
  "이천일": {
    "email": "",
    "phone": "010-9012-1364",
    "empNo": "33907"
  },
  "우건제": {
    "phone": "010-6368-6945",
    "email": "kjwoo@kbs.co.kr",
    "empNo": "20133"
  },
  "이명주": {
    "phone": "010-4462-8475",
    "email": "",
    "empNo": "34382"
  },
  "이명준": {
    "phone": "010-4462-8475",
    "email": "",
    "empNo": "34382"
  },
  "김명준": {
    "empNo": "34382",
    "email": "",
    "phone": "010-4462-8475"
  },
  "김천일": {
    "empNo": "33907",
    "phone": "010-9012-1364",
    "email": ""
  },
  "정현식": {
    "empNo": "34314",
    "email": "sik@kbs.co.kr",
    "phone": "010-6776-5009"
  },
  "안영주": {
    "email": "mypine@kbs.co.kr",
    "phone": "010-4353-3461",
    "empNo": "17300"
  },
  "조성기": {
    "empNo": "31163",
    "phone": "010-6458-559701",
    "email": "8sss3@kbs.co.kr"
  },
  "장현주": {
    "empNo": "34314",
    "email": "sik@kbs.co.kr",
    "phone": "010-6776-5009"
  },
  "정현순": {
    "phone": "",
    "email": "",
    "empNo": ""
  },
  "유건제": {
    "email": "kjwoo@kbs.co.kr",
    "phone": "010-6368-6945",
    "empNo": "20133"
  },
  "최혜진": {
    "email": "choi2@kbs.co.kr",
    "phone": "010-4061-5470",
    "empNo": "30594"
  },
  "정현주": {
    "email": "sik@kbs.co.kr",
    "phone": "010-6776-5009",
    "empNo": "34314"
  },
  "전현식": {
    "email": "sik@kbs.co.kr",
    "phone": "010-6776-5009",
    "empNo": "34314"
  },
  "오승연": {
    "empNo": "16456",
    "phone": "010-8801-9605",
    "email": "thinkagain21@naver.com"
  }
};

const DEFAULT_BASELINE_MAINT_PLANS = {
  "2026-09-23": [
    {
      "task": "청원(1R)",
      "date": "2026-09-23",
      "color": "red",
      "category": "계획정파"
    },
    {
      "category": "T  V  R",
      "color": "black",
      "date": "2026-09-23",
      "task": "소수"
    }
  ],
  "2026-09-21": [
    {
      "date": "2026-09-21",
      "category": "정기점검",
      "color": "black",
      "task": "우암"
    },
    {
      "task": "상촌",
      "date": "2026-09-21",
      "color": "black",
      "category": "T  V  R"
    }
  ],
  "2026-10-20": [
    {
      "date": "2026-10-20",
      "category": "정기점검",
      "task": "청원",
      "color": "black"
    },
    {
      "category": "계획정파",
      "task": "우암(1TV/음악FM)",
      "color": "blue",
      "date": "2026-10-20"
    },
    {
      "color": "blue",
      "date": "2026-10-20",
      "category": "계획정파",
      "task": "가엽(1TV/DMB)"
    },
    {
      "date": "2026-10-20",
      "category": "T  V  R",
      "task": "미원",
      "color": "black"
    }
  ],
  "2026-09-11": [
    {
      "color": "black",
      "category": "정기점검",
      "task": "우암",
      "date": "2026-09-11"
    },
    {
      "date": "2026-09-11",
      "color": "blue",
      "task": "가엽(음악FM)",
      "category": "계획정파"
    }
  ],
  "2026-09-01": [
    {
      "task": "청원",
      "color": "black",
      "category": "정기점검",
      "date": "2026-09-01"
    },
    {
      "color": "blue",
      "category": "계획정파",
      "task": "우암(1TV/음악FM)",
      "date": "2026-09-01"
    },
    {
      "color": "blue",
      "category": "계획정파",
      "date": "2026-09-01",
      "task": "가엽(1TV/DMB)"
    },
    {
      "category": "T  V  R",
      "task": "청산",
      "color": "black",
      "date": "2026-09-01"
    }
  ],
  "2026-10-28": [
    {
      "task": "우암",
      "color": "black",
      "date": "2026-10-28",
      "category": "정기점검"
    },
    {
      "color": "blue",
      "task": "청원(1R)",
      "date": "2026-10-28",
      "category": "계획정파"
    },
    {
      "category": "T  V  R",
      "task": "교육FMR(연)",
      "color": "black",
      "date": "2026-10-28"
    }
  ],
  "2026-10-07": [
    {
      "color": "black",
      "category": "정기점검",
      "task": "우암",
      "date": "2026-10-07"
    },
    {
      "date": "2026-10-07",
      "task": "산외",
      "category": "T  V  R",
      "color": "black"
    }
  ],
  "2026-09-02": [
    {
      "category": "정기점검",
      "date": "2026-09-02",
      "color": "black",
      "task": "우암"
    },
    {
      "date": "2026-09-02",
      "color": "black",
      "task": "학산",
      "category": "T  V  R"
    }
  ],
  "2026-09-25": [
    {
      "date": "2026-09-25",
      "task": "가엽(음악FM)",
      "color": "blue",
      "category": "계획정파"
    }
  ],
  "2026-10-27": [
    {
      "color": "red",
      "date": "2026-10-27",
      "task": "우암(1TV/DMB/표준FM)",
      "category": "계획정파"
    },
    {
      "category": "계획정파",
      "date": "2026-10-27",
      "color": "blue",
      "task": "식장(음악FM)"
    },
    {
      "task": "칠성",
      "date": "2026-10-27",
      "color": "black",
      "category": "T  V  R"
    }
  ],
  "2026-10-09": [
    {
      "color": "blue",
      "category": "계획정파",
      "date": "2026-10-09",
      "task": "가엽(음악FM)"
    }
  ],
  "2026-09-22": [
    {
      "date": "2026-09-22",
      "task": "청원",
      "category": "정기점검",
      "color": "black"
    },
    {
      "date": "2026-09-22",
      "task": "��암(1TV/DMB/표준FM)",
      "category": "계획정파",
      "color": "blue"
    },
    {
      "task": "식장(음악FM)",
      "color": "blue",
      "date": "2026-09-22",
      "category": "계획정파"
    }
  ],
  "2026-09-16": [
    {
      "category": "정기점검",
      "color": "black",
      "task": "우암",
      "date": "2026-09-16"
    },
    {
      "date": "2026-09-16",
      "category": "T  V  R",
      "task": "교육FMR(연)",
      "color": "black"
    }
  ],
  "2026-09-18": [
    {
      "date": "2026-09-18",
      "task": "우암",
      "color": "black",
      "category": "정기점검"
    },
    {
      "color": "blue",
      "date": "2026-09-18",
      "task": "가엽(표준FM)",
      "category": "계획정파"
    }
  ],
  "2026-10-01": [
    {
      "task": "회북",
      "date": "2026-10-01",
      "color": "black",
      "category": "T  V  R"
    }
  ],
  "2026-10-26": [
    {
      "category": "정기점검",
      "date": "2026-10-26",
      "color": "black",
      "task": "우암"
    }
  ],
  "2026-10-15": [
    {
      "color": "black",
      "date": "2026-10-15",
      "category": "T  V  R",
      "task": "금적산"
    }
  ],
  "2026-09-07": [
    {
      "date": "2026-09-07",
      "category": "정기점검",
      "color": "black",
      "task": "우암"
    },
    {
      "color": "black",
      "date": "2026-09-07",
      "task": "무선국수검",
      "category": "전기/기타"
    }
  ],
  "2026-09-10": [
    {
      "date": "2026-09-10",
      "task": "청원",
      "category": "정기점검",
      "color": "black"
    },
    {
      "category": "T  V  R",
      "color": "black",
      "date": "2026-09-10",
      "task": "옥천TVR"
    }
  ],
  "2026-09-08": [
    {
      "category": "정기점검",
      "date": "2026-09-08",
      "color": "black",
      "task": "우암"
    },
    {
      "color": "black",
      "category": "전기/기타",
      "task": "무선국수검",
      "date": "2026-09-08"
    },
    {
      "color": "blue",
      "category": "계획정파",
      "date": "2026-09-08",
      "task": "우암(1TV/DMB/표준FM)"
    },
    {
      "date": "2026-09-08",
      "color": "blue",
      "task": "식장(음악FM)",
      "category": "계획정파"
    },
    {
      "date": "2026-09-08",
      "task": "괴산",
      "category": "T  V  R",
      "color": "black"
    }
  ],
  "2026-10-22": [
    {
      "task": "속리",
      "category": "T  V  R",
      "color": "black",
      "date": "2026-10-22"
    }
  ],
  "2026-10-21": [
    {
      "color": "black",
      "task": "우암",
      "category": "정기점검",
      "date": "2026-10-21"
    }
  ],
  "2026-10-29": [
    {
      "category": "T  V  R",
      "color": "black",
      "date": "2026-10-29",
      "task": "두태산"
    }
  ],
  "2026-10-16": [
    {
      "task": "우암",
      "category": "정기점검",
      "color": "black",
      "date": "2026-10-16"
    },
    {
      "date": "2026-10-16",
      "task": "가엽(표준FM)",
      "category": "계획정파",
      "color": "blue"
    }
  ],
  "2026-10-19": [
    {
      "category": "정기점검",
      "task": "우암",
      "date": "2026-10-19",
      "color": "black"
    }
  ],
  "2026-09-29": [
    {
      "color": "black",
      "task": "청원",
      "date": "2026-09-29",
      "category": "정기점검",
      "order": 1
    },
    {
      "color": "black",
      "task": "청원전기대행",
      "date": "2026-09-29",
      "category": "전기/기타",
      "order": 2
    },
    {
      "color": "black",
      "category": "T  V  R",
      "date": "2026-09-29",
      "order": 3,
      "task": "영동"
    }
  ],
  "2026-09-30": [
    {
      "task": "우암",
      "date": "2026-09-30",
      "color": "black",
      "category": "정기점검"
    }
  ],
  "2026-09-09": [
    {
      "date": "2026-09-09",
      "color": "black",
      "category": "정기점검",
      "task": "우암"
    },
    {
      "category": "계획정파",
      "date": "2026-09-09",
      "color": "blue",
      "task": "청원(1R)"
    }
  ],
  "2026-09-17": [
    {
      "color": "black",
      "category": "정기점검",
      "task": "청원",
      "date": "2026-09-17"
    },
    {
      "date": "2026-09-17",
      "task": "청원전기대행",
      "category": "전기/기타",
      "color": "black"
    },
    {
      "task": "청천",
      "date": "2026-09-17",
      "category": "T  V  R",
      "color": "black"
    }
  ],
  "2026-09-14": [
    {
      "date": "2026-09-14",
      "category": "정기점검",
      "task": "우암",
      "color": "black"
    }
  ],
  "2026-10-14": [
    {
      "category": "정기점검",
      "date": "2026-10-14",
      "color": "black",
      "task": "우암"
    },
    {
      "category": "계획정파",
      "color": "blue",
      "task": "청원(1R)",
      "date": "2026-10-14"
    },
    {
      "task": "교육FMR(연)",
      "date": "2026-10-14",
      "color": "black",
      "category": "T  V  R"
    }
  ],
  "2026-10-30": [
    {
      "task": "우암",
      "date": "2026-10-30",
      "color": "black",
      "category": "정기점검"
    }
  ],
  "2026-10-06": [
    {
      "color": "black",
      "task": "청원",
      "category": "정기점검",
      "order": 1,
      "date": "2026-10-06"
    },
    {
      "color": "blue",
      "date": "2026-10-06",
      "task": "우암(1TV/음악FM)",
      "order": 2,
      "category": "계획정파"
    },
    {
      "order": 3,
      "task": "가엽(1TV/DMB)",
      "date": "2026-10-06",
      "color": "blue",
      "category": "계획정파"
    },
    {
      "order": 4,
      "date": "2026-10-06",
      "category": "T  V  R",
      "task": "황간TVR",
      "color": "black"
    }
  ],
  "2026-10-12": [
    {
      "date": "2026-10-12",
      "color": "black",
      "task": "우암",
      "category": "정기점검"
    }
  ],
  "2026-10-13": [
    {
      "category": "정기점검",
      "date": "2026-10-13",
      "task": "청원",
      "color": "black"
    },
    {
      "color": "red",
      "category": "계획정파",
      "task": "가엽(1TV/DMB)",
      "date": "2026-10-13"
    },
    {
      "task": "식장(음악FM)",
      "date": "2026-10-13",
      "category": "계획정파",
      "color": "blue"
    },
    {
      "category": "T  V  R",
      "color": "black",
      "task": "추풍령",
      "date": "2026-10-13"
    }
  ],
  "2026-09-15": [
    {
      "category": "전기/기타",
      "date": "2026-09-15",
      "color": "black",
      "task": "전기설비 법정검사"
    },
    {
      "task": "우암(1TV/음악FM)",
      "date": "2026-09-15",
      "category": "계획정파",
      "color": "red"
    },
    {
      "color": "red",
      "category": "계획정파",
      "task": "가엽(1TV/DMB/표준/음악)",
      "date": "2026-09-15"
    },
    {
      "category": "T  V  R",
      "date": "2026-09-15",
      "task": "보은",
      "color": "black"
    }
  ],
  "2026-10-23": [
    {
      "task": "우암",
      "category": "정기점검",
      "color": "black",
      "date": "2026-10-23"
    },
    {
      "category": "계획정파",
      "date": "2026-10-23",
      "color": "red",
      "task": "가엽(음악FM)"
    }
  ],
  "2026-09-04": [
    {
      "task": "우암",
      "date": "2026-09-04",
      "color": "black",
      "category": "정기점검"
    },
    {
      "color": "blue",
      "task": "가엽(표준FM)",
      "category": "계획정파",
      "date": "2026-09-04"
    }
  ],
  "2026-10-02": [
    {
      "date": "2026-10-02",
      "task": "우암",
      "category": "정기점검",
      "color": "black"
    },
    {
      "date": "2026-10-02",
      "task": "가엽(표준FM)",
      "color": "blue",
      "category": "계획정파"
    }
  ]
};

const DEFAULT_BASELINE_MAINT_META = {
  "sourceFile": "202610업무계획_작성중.hwp, 202607업무계획_수정.hwp, 202608업무계획.hwp, 202601업무계획.hwp, 202602업무계획.hwp, 202603업무계획.hwp, 202604업무계획.hwp, 202605업무계획.hwp, 202609업무계획_수정.hwpx, 202609업무계획_수정.docx, 202610업무계획.docx",
  "lastSync": "2026-09-29T13:44:51.626217",
  "folder": "C:\\Users\\KBS\\Desktop\\송출센터근무코딩\\점검계획_폴더",
  "totalCount": 86
};

const DEFAULT_BASELINE_MAINT_MEMOS = [
  {
    "content": "이 TV 송신기 점검 하고 발전기 점검 했는데 이상이 있어서 조치 했음",
    "target": "우암산송신소",
    "createdAt": 1790740529116,
    "updatedAt": 1790740529116,
    "author": "",
    "date": "2026-09-29",
    "id": "memo_1790740529116_adjhu3",
    "category": "송신소"
  },
  {
    "target": "두태TVR",
    "createdAt": 1790740174126,
    "date": "2026-09-30",
    "id": "memo_1790740174126_6mn5zg",
    "updatedAt": 1790740174126,
    "content": "TV 송신기를 점검하고 출력도 체크 하고 안테나 위치 고정 수신기 파악해서 연결이 올바른지 다시 고정 했음",
    "author": "",
    "category": "TVR"
  },
  {
    "createdAt": 1790740145476,
    "id": "memo_1790740145476_m6wmhm",
    "author": "안영주",
    "updatedAt": 1790740145476,
    "category": "송신소",
    "target": "청원송신소",
    "content": "송신소에 가서 송신기를 점검 하고 출력도 점검 하고 안테나 점검 하고 그리고 발전기도 점검 함",
    "date": "2026-09-30"
  },
  {
    "author": "조성기",
    "id": "memo_1790732899281_do7w1u",
    "content": "1TV 송신기 점루ㄹㄹ���러러러하허ㅓ러ㅓ러허허허허ㅓ헣",
    "date": "2026-09-30",
    "category": "송신소",
    "updatedAt": 1790738447892,
    "target": "우암산송신소",
    "createdAt": 1790732899281
  }
];

const DEFAULT_BASELINE_WORK_MEMOS = {};

if (typeof window !== 'undefined') {
  window.DEFAULT_BASELINE_MEMBERS = DEFAULT_BASELINE_MEMBERS;
  window.DEFAULT_BASELINE_CHIEF = DEFAULT_BASELINE_CHIEF;
  window.DEFAULT_BASELINE_MAINT_MEMBERS = DEFAULT_BASELINE_MAINT_MEMBERS;
  window.DEFAULT_BASELINE_LEAVES = DEFAULT_BASELINE_LEAVES;
  window.DEFAULT_BASELINE_PERSON_CONTACTS = DEFAULT_BASELINE_PERSON_CONTACTS;
  window.DEFAULT_BASELINE_MAINT_PLANS = DEFAULT_BASELINE_MAINT_PLANS;
  window.DEFAULT_BASELINE_MAINT_META = DEFAULT_BASELINE_MAINT_META;
  window.DEFAULT_BASELINE_MAINT_MEMOS = DEFAULT_BASELINE_MAINT_MEMOS;
  window.DEFAULT_BASELINE_WORK_MEMOS = DEFAULT_BASELINE_WORK_MEMOS;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DEFAULT_BASELINE_MEMBERS,
    DEFAULT_BASELINE_CHIEF,
    DEFAULT_BASELINE_MAINT_MEMBERS,
    DEFAULT_BASELINE_LEAVES,
    DEFAULT_BASELINE_PERSON_CONTACTS,
    DEFAULT_BASELINE_MAINT_PLANS,
    DEFAULT_BASELINE_MAINT_META,
    DEFAULT_BASELINE_MAINT_MEMOS,
    DEFAULT_BASELINE_WORK_MEMOS
  };
}
